import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize the Gemini client.
// Note: This requires GEMINI_API_KEY to be set in the .env file.
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'MISSING_KEY');

export const getLatestAIStatus = () => {
  return { online: true, displayStatus: 'AI Service Online', isError: false, details: {} };
};

export const initAIServiceMonitor = () => {
  console.log('[AI Service] Monitor initialized');
};

const MODEL_ROUTING = {
  fast: ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.0-flash"],
  reasoning: ["gemini-2.5-pro", "gemini-pro-latest"],
  visual: ["gemini-2.5-pro", "gemini-2.5-flash"],
  embedding: ["gemini-embedding-2", "gemini-embedding-001"]
};

const delay = ms => new Promise(res => setTimeout(res, ms));

const executeWithFallback = async (taskType, executeFn) => {
  let lastError;
  const models = MODEL_ROUTING[taskType] || MODEL_ROUTING.fast;
  
  for (const modelName of models) {
    let retries = 1; // Reduced from 5 to prevent 5-minute UI hangs
    while (retries > 0) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        
        // Add a 2-minute timeout to prevent hanging indefinitely
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Gemini API Timeout (120s)')), 120000);
        });
        
        return await Promise.race([executeFn(model), timeoutPromise]);
      } catch (error) {
        lastError = error;
        if (error.status === 429 || (error.message && error.message.includes('429'))) {
          console.warn(`Model ${modelName} hit rate limit (429). Fast failing...`);
          // We don't want to freeze the UI for 5 minutes on free tier. Just break and try fallback model.
          break;
        } else {
          console.warn(`Model ${modelName} failed for task '${taskType}' with error: ${error.message}. Retrying with next fallback model...`);
          break; // break out of retry loop to try next model
        }
      }
    }
  }
  throw lastError;
};

/**
 * Generates a vector embedding for a given string of text.
 * @param {string} text The text chunk to embed.
 * @returns {Promise<Array<number>>} The vector array (e.g., 768 dimensions).
 */
export const generateEmbedding = async (text) => {
  if (!process.env.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY is not set. Returning dummy embedding.");
    // Return a dummy array if no key (so development doesn't crash completely)
    return new Array(768).fill(0.01);
  }

  try {
    const result = await executeWithFallback('embedding', async (model) => {
      return await model.embedContent(text);
    });
    return result.embedding.values;
  } catch (error) {
    console.error("Error generating embedding from Gemini:", error);
    throw error;
  }
};

/**
 * Generates vector embeddings for an array of text chunks in bulk batches of 100.
 * @param {Array<string>} texts Array of text chunks to embed.
 * @returns {Promise<Array<Array<number>>>} Array of vector arrays.
 */
export const generateEmbeddingsBatch = async (texts) => {
  if (!process.env.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY is not set. Returning dummy embeddings.");
    return texts.map(() => new Array(768).fill(0.01));
  }
  if (!texts || texts.length === 0) return [];

  try {
    const allEmbeddings = [];
    const MAX_BATCH_SIZE = 100;
    
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batchTexts = texts.slice(i, i + MAX_BATCH_SIZE);
      const requests = batchTexts.map(text => ({
        content: { role: 'user', parts: [{ text }] }
      }));
      
      const result = await executeWithFallback('embedding', async (model) => {
        return await model.batchEmbedContents({ requests });
      });
      
      allEmbeddings.push(...result.embeddings.map(e => e.values));
    }
    
    return allEmbeddings;
  } catch (error) {
    console.error("Error generating batch embeddings from Gemini:", error);
    throw error;
  }
};

/**
 * Passes a document/image to Gemini to extract and describe all diagrams/charts.
 * @param {Buffer} fileBuffer The raw file buffer
 * @param {string} mimeType The mime type of the file
 * @returns {Promise<Array<string>>} An array of semantic text descriptions
 */
export const extractVisualDescriptions = async (fileBuffer, mimeType = "application/pdf") => {
  if (!process.env.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY not set. Skipping visual extraction.");
    return [];
  }

  try {
    const prompt = `
      Analyze this PDF. Find every chart, graph, diagram, or flowchart. 
      For each one, provide an exhaustive text description detailing the axes, the flow of information, the key labels, and the overall conclusion. 
      If there are no diagrams, return an empty JSON array [].
      Return the response as a strict JSON array of strings, where each string describes one diagram.
      Do not include any Markdown blocks like \`\`\`json, just the raw array.
    `;

    const filePart = {
      inlineData: {
        data: fileBuffer.toString("base64"),
        mimeType: mimeType
      }
    };

    const result = await executeWithFallback('visual', async (model) => {
      return await model.generateContent([prompt, filePart]);
    });
    const responseText = result.response.text().trim();
    
    // Clean up potential markdown blocks if the LLM ignores instructions
    const cleanJsonStr = responseText.replace(/^```json/g, "").replace(/```$/g, "").trim();
    
    try {
      const descriptions = JSON.parse(cleanJsonStr);
      if (Array.isArray(descriptions)) {
        return descriptions;
      }
      return [];
    } catch (parseError) {
      console.error("Failed to parse Gemini visual descriptions as JSON:", cleanJsonStr);
      return [];
    }
  } catch (error) {
    console.error("Error extracting visual descriptions from Gemini:", error);
    // Don't fail the entire digestion if visual extraction fails, just return empty array
    return [];
  }
};

/**
 * Generates a structured Study Guide (Markdown) from the raw document text.
 * @param {string} rawText The extracted text from the document
 * @returns {Promise<string>} Markdown string of the study guide
 */
export const generateStudyGuide = async (rawText) => {
  if (!process.env.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY not set. Skipping study guide generation.");
    return "# Study Guide\n\n*API Key missing. Unable to generate summary.*";
  }

  try {
    const prompt = `
      You are an expert tutor. Summarize the following document into a structured Study Guide formatted in Markdown.
      Include:
      1. A brief overview (2-3 sentences).
      2. A bulleted list of 5-7 core concepts.
      3. A list of key vocabulary terms and their definitions.
      Do not include any text outside of the Markdown structure.

      --- DOCUMENT TEXT ---
      ${rawText}
    `;

    const result = await executeWithFallback('reasoning', async (model) => {
      return await model.generateContent(prompt);
    });
    return result.response.text().trim();
  } catch (error) {
    console.error("Error generating study guide from Gemini:", error);
    return "# Study Guide\n\n*An error occurred while generating the summary.*";
  }
};

/**
 * Generates an answer to the user's query using ONLY the provided context chunks.
 * @param {string} query The user's question
 * @param {string} context Combined text of the most relevant chunks
 * @returns {Promise<string>} The AI's answer
 */
export const generateRagResponse = async (query, context) => {
  if (!process.env.GEMINI_API_KEY) {
    return "API Key is missing. Cannot search documents.";
  }

  try {
    const prompt = `
      You are an expert study assistant. Answer the user's question using ONLY the provided context from their attached documents. 
      If the answer is not contained in the context, explicitly state 'I do not have enough information in the attached documents to answer this.' 
      Do not make things up.

      --- CONTEXT ---
      ${context}

      --- USER QUESTION ---
      ${query}
    `;

    const result = await executeWithFallback('fast', async (model) => {
      return await model.generateContent(prompt);
    });
    return result.response.text().trim();
  } catch (error) {
    console.error("Error generating RAG response from Gemini:", error);
    return "Sorry, I encountered an error while trying to answer your question.";
  }
};

/**
 * Generates an answer to the user's query and streams the response back token by token.
 * @param {string} query The user's question
 * @param {string} context Combined text of the most relevant chunks
 * @returns {AsyncGenerator<string>} A generator yielding chunks of text
 */
export const streamRagResponse = async function* (query, context, canvasContext = '', selectedText = '', action = 'custom', chatHistoryContext = '') {
  if (!process.env.GEMINI_API_KEY) {
    yield "API Key is missing. Cannot search documents.";
    return;
  }

  try {
    let actionInstructions = '';
    if (action === 'improve') {
      actionInstructions = `
      You are an expert editor. You have been asked to IMPROVE the following selected text.
      Return ONLY the improved text. Do not include conversational filler (like "Here is the improved text:").
      `;
    } else if (action === 'summarize') {
      actionInstructions = `
      You are an expert editor. Summarize the selected text concisely.
      `;
    } else if (action === 'explain') {
      actionInstructions = `
      You are an expert tutor. Explain the selected text clearly.
      `;
    } else {
      actionInstructions = `
      You are an expert study assistant. Use the provided context from attached documents and the canvas if it is relevant to the user's question. 
      If the context does not contain the answer, answer the question accurately using your own general knowledge.
      Take the RECENT CHAT HISTORY into account if the user is asking a follow-up question.
      `;
    }

    const prompt = `
      ${actionInstructions}

      --- RECENT CHAT HISTORY ---
      ${chatHistoryContext}

      --- PDF ATTACHMENT CONTEXT ---
      ${context}

      --- ENTIRE CANVAS CONTEXT ---
      ${canvasContext}

      --- SELECTED TEXT ---
      ${selectedText}

      --- USER REQUEST ---
      ${query}
    `;

    // Use reasoning models for complex actions, fast models for general chat
    const taskType = (action === 'custom') ? 'fast' : 'reasoning';
    
    const result = await executeWithFallback(taskType, async (model) => {
      return await model.generateContentStream(prompt);
    });
    
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      yield chunkText;
    }
  } catch (error) {
    console.error("Error streaming RAG response from Gemini:", error);
    yield `Sorry, I encountered an error: ${error.message || "Failed to generate stream"}`;
  }
};

/**
 * Generates Mermaid.js code based on the query and context.
 * @param {string} query The user's question
 * @param {string} context Combined text of the most relevant chunks
 * @returns {Promise<string>} Raw Mermaid.js code
 */
export const generateDiagramResponse = async (query, context, selectedText = '') => {
  if (!process.env.GEMINI_API_KEY) {
    return "graph TD\n  A[Error] --> B[API Key is missing]";
  }

  try {
    const prompt = `
      You are an expert system architect and educator. Based on the provided Source Context, generate a diagram representing the requested concept.
      
      CRITICAL INSTRUCTIONS:
      1. YOU MUST RESPOND ONLY WITH RAW MERMAID.JS CODE.
      2. Do not use Markdown backticks (e.g., \`\`\`mermaid).
      3. Start directly with the graph definition (e.g., 'graph TD', 'sequenceDiagram', 'pie title', 'mindmap', etc.).
      4. Do not include any conversational text, pleasantries, or explanations.
      5. ESSENTIAL: You MUST include descriptive, readable text labels inside every node. Never leave a node empty or just use a single letter. For example, use A[Independent Clause] instead of just A. Use rich descriptive text to make the flowchart visually meaningful.
      
      --- SELECTED TEXT (PRIMARY FOCUS) ---
      ${selectedText}

      --- CONTEXT ---
      ${context}

      --- USER REQUEST ---
      ${query}
    `;

    const result = await executeWithFallback('reasoning', async (model) => {
      return await model.generateContent(prompt);
    });
    let code = result.response.text().trim();
    
    // Clean up if the model accidentally included markdown backticks
    if (code.startsWith('```mermaid')) {
      code = code.replace(/^```mermaid\n/, '');
      code = code.replace(/\n```$/, '');
    } else if (code.startsWith('```')) {
      code = code.replace(/^```\n/, '');
      code = code.replace(/\n```$/, '');
    }
    
    return code;
  } catch (error) {
    console.error("Error generating RAG diagram from Gemini:", error);
    return "graph TD\n  A[Error] --> B[Failed to generate diagram]";
  }
};
