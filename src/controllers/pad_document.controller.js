import db from '../config/database.config.js';
import { startDigestion } from '../services/digestion.service.js';

/**
 * Attaches a file from the Bag to the Smart Pad.
 * This triggers the digestion process (to be implemented in Part 2).
 */
export const attachDocument = async (req, res) => {
  const { id: padId } = req.params;
  const { fileId } = req.body;
  const userId = req.user.id;
  const role = req.user.role;

  try {
    if (padId === 'new' || padId === 'undefined') {
      return res.status(400).json({ error: 'Please save your pad (give it a title) before attaching documents.' });
    }

    // 1. Verify pad ownership
    const padOwnerField = role === 'student' ? 'owner_student_id' : 'owner_teacher_id';
    const padQuery = `SELECT id FROM writing_pads WHERE id = $1 AND ${padOwnerField} = $2 AND is_deleted = FALSE`;
    const padResult = await db.query(padQuery, [padId, userId]);

    if (padResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pad not found or unauthorized' });
    }

    // 2. Verify file exists in bag
    const fileOwnerField = role === 'student' ? 'owner_student_id' : 'owner_teacher_id';
    const fileQuery = `
      SELECT id, file_url, file_name 
      FROM bag_files
      WHERE id = $1 AND ${fileOwnerField} = $2
    `;
    const fileResult = await db.query(fileQuery, [fileId, userId]);

    if (fileResult.rows.length === 0) {
      return res.status(404).json({ error: 'File not found or unauthorized' });
    }

    // 3. Attach file to pad
    const insertQuery = `
      INSERT INTO pad_documents (pad_id, file_id, status)
      VALUES ($1, $2, 'processing')
      RETURNING *
    `;
    const insertResult = await db.query(insertQuery, [padId, fileId]);

    // Trigger background digestion process asynchronously
    startDigestion(insertResult.rows[0].id, fileResult.rows[0].file_url, fileResult.rows[0].file_name).catch(err => {
      console.error('Digestion worker failed:', err);
    });

    res.status(201).json({
      message: 'Document attached successfully. Digestion started.',
      document: insertResult.rows[0]
    });
  } catch (error) {
    if (error.code === '23505') { // unique violation
      return res.status(409).json({ error: 'Document is already attached to this pad' });
    }
    console.error('Error attaching document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Removes a document from the pad.
 * This automatically cascades to delete all chunks and vectors.
 */
export const removeDocument = async (req, res) => {
  const { id: padId, docId } = req.params;
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

    // 2. Delete the document
    const deleteQuery = `
      DELETE FROM pad_documents
      WHERE id = $1 AND pad_id = $2
      RETURNING id
    `;
    const deleteResult = await db.query(deleteQuery, [docId, padId]);

    if (deleteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found in this pad' });
    }

    res.status(200).json({ message: 'Document removed from pad successfully' });
  } catch (error) {
    console.error('Error removing document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Gets all documents attached to a specific pad, including their AI summaries.
 */
export const getPadDocuments = async (req, res) => {
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

    // 2. Fetch documents
    const fetchQuery = `
      SELECT 
        pd.id as pad_document_id,
        pd.ai_summary,
        pd.status,
        pd.created_at,
        f.id as file_id,
        f.file_name,
        f.file_url
      FROM pad_documents pd
      JOIN bag_files f ON pd.file_id = f.id
      WHERE pd.pad_id = $1
      ORDER BY pd.created_at DESC
    `;
    const docsResult = await db.query(fetchQuery, [padId]);

    res.status(200).json(docsResult.rows);
  } catch (error) {
    console.error('Error fetching pad documents:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
