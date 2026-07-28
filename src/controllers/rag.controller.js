import db from '../config/database.config.js';
import { generateEmbedding, streamRagResponse, generateDiagramResponse } from '../services/ai.service.js';

/**
 * Calculates cosine similarity between two vectors (arrays of numbers).
 */
const cosineSimilarity = (vecA, vecB) => {
  if (vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

/**
 * Fetches the chat history for a specific Pad.
 */
export const getChatHistory = async (req, res) => {
  const { id: padId } = req.params;
  const userId = req.user.id;
  const role = req.user.role;

  try {
    // 1. Verify pad ownership
    const padOwnerField = role === 'student' ? 'owner_student_id' : 'owner_teacher_id';
    const padQuery = `SELECT id FROM writing_pads WHERE id = $1 AND ${padOwnerField} = $2 AND is_deleted = FALSE`;
    const padResult = await db.query(padQuery, [padId, userId]);

    if (padResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pad not found or unauthorized' });
    }

    const chatsQuery = `
      SELECT id, role, content, type, created_at 
      FROM pad_ai_chats 
      WHERE pad_id = $1 
      ORDER BY created_at ASC
    `;
    const chatsResult = await db.query(chatsQuery, [padId]);
    
    res.json(chatsResult.rows);
  } catch (error) {
    console.error('Error fetching chat history:', error);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
};

/**
 * Handles RAG (Retrieval-Augmented Generation) queries for a specific Pad.
 */
export const askQuestion = async (req, res) => {
  const { id: padId } = req.params;
  const { query, canvasContext = '', selectedText = '', action = 'custom' } = req.body;
  const userId = req.user.id;
  const role = req.user.role;

  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  // Prevent database errors if the pad hasn't been saved yet
  if (padId === 'new' || padId === 'undefined') {
    return res.status(400).json({ error: 'Please save your pad first before using the AI assistant.' });
  }

  try {
    // 1. Verify pad ownership
    const padOwnerField = role === 'student' ? 'owner_student_id' : 'owner_teacher_id';
    const padQuery = `SELECT id FROM writing_pads WHERE id = $1 AND ${padOwnerField} = $2 AND is_deleted = FALSE`;
    const padResult = await db.query(padQuery, [padId, userId]);

    if (padResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pad not found or unauthorized' });
    }

    // Save user message to DB
    await db.query(
      `INSERT INTO pad_ai_chats (pad_id, role, content) VALUES ($1, $2, $3)`,
      [padId, 'user', query]
    );

    // Fetch recent chat history for context (e.g., last 10 messages)
    const historyQuery = `
      SELECT role, content 
      FROM pad_ai_chats 
      WHERE pad_id = $1 
      ORDER BY created_at DESC 
      LIMIT 10
    `;
    const historyResult = await db.query(historyQuery, [padId]);
    const historyRows = historyResult.rows.reverse();
    const chatHistoryContext = historyRows.map(row => `${row.role.toUpperCase()}: ${row.content}`).join('\n\n');

    let context = '';
    let queryEmbedding = null;

    // 2. Only generate embeddings and search if it's a custom query that needs document context
    if (action === 'custom') {
      try {
        queryEmbedding = await generateEmbedding(query);
      } catch (embeddingError) {
        console.warn("Embedding generation failed (likely rate limit). Skipping document context.", embeddingError.message);
        // Continue without context so the AI can at least use general knowledge
      }
    }

    if (queryEmbedding) {
      // 3. Fetch all chunks for this pad
      const chunksQuery = `
        SELECT dc.content, dc.embedding
        FROM document_chunks dc
        JOIN pad_documents pd ON dc.pad_document_id = pd.id
        WHERE pd.pad_id = $1 AND pd.status = 'completed'
      `;
      const chunksResult = await db.query(chunksQuery, [padId]);
      const chunks = chunksResult.rows;

      if (chunks.length > 0) {
        // 4. Calculate cosine similarity for all chunks
        const scoredChunks = chunks.map(chunk => {
          const chunkEmbedding = typeof chunk.embedding === 'string' 
            ? JSON.parse(chunk.embedding) 
            : chunk.embedding;
          
          const score = cosineSimilarity(queryEmbedding, chunkEmbedding);
          return { ...chunk, score };
        });

        // 5. Sort by score (descending) and take top 5
        scoredChunks.sort((a, b) => b.score - a.score);
        const topChunks = scoredChunks.slice(0, 5);

        // 6. Build the context string
        context = topChunks.map(c => c.content).join('\n\n');
      }
    }

    // 7. Setup SSE Headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const isDiagramRequest = /(draw|diagram|chart|graph|map|flowchart)/i.test(query) || action === 'custom' && query.includes('flowchart');

    if (isDiagramRequest) {
      // For diagrams, we generate the full code at once so we can wrap it in a custom type
      const mermaidCode = await generateDiagramResponse(query, context + '\n\n--- CANVAS CONTEXT ---\n' + canvasContext, selectedText);
      
      await db.query(
        `INSERT INTO pad_ai_chats (pad_id, role, content, type) VALUES ($1, $2, $3, $4)`,
        [padId, 'bot', mermaidCode, 'diagram']
      );

      res.write(`data: ${JSON.stringify({ type: 'diagram', content: mermaidCode })}\n\n`);
    } else {
      // 9. Standard Text Stream from Gemini
      const stream = streamRagResponse(query, context, canvasContext, selectedText, action, chatHistoryContext);
      let fullBotResponse = '';
      for await (const chunk of stream) {
        fullBotResponse += chunk;
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      }
      
      // Save bot response to DB
      if (fullBotResponse) {
        await db.query(
          `INSERT INTO pad_ai_chats (pad_id, role, content) VALUES ($1, $2, $3)`,
          [padId, 'bot', fullBotResponse]
        );
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('Error processing RAG query (Outer Block):', error, error.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to answer question: ' + error.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: 'Stream interrupted: ' + error.message })}\n\n`);
      res.end();
    }
  }
};
