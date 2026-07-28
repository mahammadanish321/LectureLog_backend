import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');
import db from '../config/database.config.js';
import { generateEmbedding, generateEmbeddingsBatch, extractVisualDescriptions, generateStudyGuide } from './ai.service.js';

// Simple text chunker based on character length with overlap
const chunkText = (text, maxLen = 1000, overlap = 150) => {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + maxLen, text.length);
    chunks.push(text.substring(i, end));
    if (end === text.length) break;
    i += (maxLen - overlap);
  }
  return chunks;
};

/**
 * Background worker to digest a document, chunk it, embed it, and save it.
 * @param {string} padDocumentId The ID of the pad_documents row
 * @param {string} fileUrl The URL of the file (e.g., Cloudinary URL)
 * @param {string} fileName The original filename of the uploaded file
 */
export const startDigestion = async (padDocumentId, fileUrl, fileName = '') => {
  console.log(`[Digestion] Starting digestion for padDocumentId: ${padDocumentId}`);
  
  try {
    // 1. Download the file
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Failed to fetch file: ${response.statusText}`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 2. Extract text
    let rawText = '';
    try {
      const isPdf = fileUrl.toLowerCase().endsWith('.pdf') || fileName.toLowerCase().endsWith('.pdf');
      if (isPdf) {
        const parser = new PDFParse({ data: buffer });
        const pdfData = await parser.getText();
        rawText = pdfData.text.replace(/\s+/g, ' ').trim();
      }
    } catch (e) {
      console.warn("[Digestion] Could not parse text, might be an image.");
    }

    // 3. Chunk the text
    const chunks = rawText ? chunkText(rawText) : [];
    console.log(`[Digestion] Extracted and chunked into ${chunks.length} pieces.`);

    // 4. Generate Embeddings & Save to DB
    if (chunks.length > 0) {
      const textEmbeddings = await generateEmbeddingsBatch(chunks);
      
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = textEmbeddings[i];

        // We use JSONB for embedding as pgvector is not natively installed locally on Windows
        await db.query(
          `INSERT INTO document_chunks (pad_document_id, chunk_index, content, embedding)
           VALUES ($1, $2, $3, $4)`,
          [padDocumentId, i, chunk, JSON.stringify(embedding)]
        );
      }
    }
    
    // 5. Extract Visual Descriptions via Multimodal AI
    console.log(`[Digestion] Starting visual extraction for padDocumentId: ${padDocumentId}`);
    let mimeType = 'application/pdf';
    if (fileUrl.match(/\.(jpg|jpeg)$/i)) mimeType = 'image/jpeg';
    else if (fileUrl.match(/\.png$/i)) mimeType = 'image/png';
    else if (fileUrl.match(/\.webp$/i)) mimeType = 'image/webp';
    
    const visualDescriptions = await extractVisualDescriptions(buffer, mimeType);
    
    let chunkIndex = chunks.length; // Continue index from where text chunks left off
    
    // Filter out empty descriptions first
    const validVisualDesc = visualDescriptions.filter(desc => desc && desc.trim() !== '');
    
    if (validVisualDesc.length > 0) {
      const visualEmbeddings = await generateEmbeddingsBatch(validVisualDesc);
      
      for (let i = 0; i < validVisualDesc.length; i++) {
        const desc = validVisualDesc[i];
        const embedding = visualEmbeddings[i];
        
        await db.query(
          `INSERT INTO document_chunks (pad_document_id, chunk_index, content, embedding, is_visual_desc)
           VALUES ($1, $2, $3, $4, true)`,
          [padDocumentId, chunkIndex, desc, JSON.stringify(embedding)]
        );
        chunkIndex++;
      }
    }
    
    console.log(`[Digestion] Extracted and embedded ${visualDescriptions.length} visual descriptions.`);

    // 6. Generate Study Guide (Executive Summary)
    console.log(`[Digestion] Generating study guide for padDocumentId: ${padDocumentId}`);
    let aiSummary = '';
    if (rawText) {
      aiSummary = await generateStudyGuide(rawText);
    } else {
      aiSummary = 'This document appears to be purely visual. No text summary could be generated.';
    }

    // 7. Update status to completed and save summary
    await db.query(
      `UPDATE pad_documents SET status = 'completed', ai_summary = $1 WHERE id = $2`,
      [aiSummary, padDocumentId]
    );

    console.log(`[Digestion] Completed successfully for padDocumentId: ${padDocumentId}`);
  } catch (error) {
    console.error(`[Digestion] Failed for padDocumentId: ${padDocumentId}`, error);
    // Mark as error in DB
    await db.query(
      `UPDATE pad_documents SET status = 'error' WHERE id = $1`,
      [padDocumentId]
    ).catch(e => console.error("Could not update status to error", e));
  }
};
