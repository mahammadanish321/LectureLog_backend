import pool from '../config/database.config.js';
import Message from '../models/message.model.js';
import { chatNamespace } from '../services/chat.service.js';

export const uploadNote = async (req, res) => {
  const { schedule_id, session_id, file_name, upload_date } = req.body;
  const teacher_id = req.user.id;

  try {
    const files = req.files || (req.file ? [req.file] : []);
    
    if (files.length === 0) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const insertedNotes = [];
    const fileUrls = [];

    // Extract subject/org data for chat and bag syncing
    let subject_id, year, stream, orgId, sName;
    if (schedule_id) {
      const sRes = await pool.query(`
        SELECT s.subject_id, s.year, s.stream, s.organization_id, sub.name as subject_name 
        FROM schedules s 
        JOIN subjects sub ON s.subject_id = sub.id 
        WHERE s.id = $1
      `, [schedule_id]);
      if (sRes.rowCount > 0) {
        ({ subject_id, year, stream, organization_id: orgId } = sRes.rows[0]);
        sName = sRes.rows[0].subject_name;
      }
    } else if (session_id) {
      const seRes = await pool.query(`
        SELECT se.subject_id, sub.name as subject_name, sub.organization_id 
        FROM sessions se 
        JOIN subjects sub ON se.subject_id = sub.id 
        WHERE se.id = $1
      `, [session_id]);
      if (seRes.rowCount > 0) {
        ({ subject_id, organization_id: orgId } = seRes.rows[0]);
        sName = seRes.rows[0].subject_name;
        
        // Find year and stream from schedules for this subject
        const schRes = await pool.query('SELECT year, stream FROM schedules WHERE subject_id = $1 LIMIT 1', [subject_id]);
        if (schRes.rowCount > 0) {
          ({ year, stream } = schRes.rows[0]);
        } else {
          year = '1';
          stream = 'CSE';
        }
      }
    }

    // Check if it's the first time notes are being added to this session
    const existingNotesCountRes = await pool.query(
      'SELECT id FROM class_notes WHERE (schedule_id = $1 AND schedule_id IS NOT NULL) OR (session_id = $2 AND session_id IS NOT NULL) LIMIT 1',
      [schedule_id || null, session_id || null]
    );
    const isFirstNote = existingNotesCountRes.rowCount === 0;

    const { syncNoteToBag } = await import('../services/bag.service.js');

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const file_url = file.path;
      fileUrls.push(file_url);

      const fName = file_name ? (files.length > 1 ? `${file_name}_${i+1}` : file_name) : file.originalname;

      const { rows } = await pool.query(
        `INSERT INTO class_notes (schedule_id, session_id, teacher_id, file_url, file_name, upload_date)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [schedule_id || null, session_id || null, teacher_id, file_url, fName, upload_date]
      );
      insertedNotes.push(rows[0]);

      // Sync to Bag system
      if (sName) {
        await syncNoteToBag({
          teacher_id,
          subject_id,
          subject_name: sName,
          year,
          stream,
          orgId,
          upload_date,
          file_url,
          file_name: fName,
          mime_type: file.mimetype,
          file_size: file.size || 0
        });
      }
    }
    
    // Auto broadcast to chat node
    if (chatNamespace && isFirstNote && subject_id) {
      try {
        // Find chat group ID
        const groupRes = await pool.query(
          'SELECT id FROM chat_groups WHERE subject_id = $1 AND year = $2 AND stream = $3 AND organization_id = $4 LIMIT 1',
          [subject_id, year || '1', stream || 'CSE', orgId]
        );
        
        if (groupRes.rowCount > 0) {
          const groupId = groupRes.rows[0].id;
          const folderName = `${sName} - Year ${year} (${stream}) - ${upload_date}`;
          
          const newMsg = new Message({
            groupId,
            organizationId: orgId || req.user.organization_id,
            senderId: req.user.id,
            senderType: req.user.role,
            senderName: req.user.name,
            content: '',
            attachmentUrls: [], // No longer rely on static URLs for notes folder
            isNoteFolder: true,
            scheduleId: schedule_id || null,
            sessionId: session_id || null,
            noteFolderName: folderName,
            replyTo: null
          });
          await newMsg.save();

          chatNamespace.to(`group_${groupId}`).emit("receive_message", newMsg.toObject());
        }
      } catch (broadcastErr) {
        console.error("Error broadcasting note to chat:", broadcastErr);
      }
    }

    res.status(201).json({ message: 'Note uploaded successfully', notes: insertedNotes });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getNotes = async (req, res) => {
  const { schedule_id, session_id, date, subject_id, year, stream } = req.query;
  const orgId = req.user.organization_id;
  const userId = req.user.id;

  try {
    let query = `
      SELECT n.* 
      FROM class_notes n
      LEFT JOIN schedules sc ON n.schedule_id = sc.id
      LEFT JOIN sessions se ON n.session_id = se.id
      WHERE (sc.organization_id = $1 OR se.organization_id = $1 OR n.teacher_id = $2)
    `;
    const params = [orgId, userId];

    if (schedule_id) {
      params.push(schedule_id);
      query += ` AND n.schedule_id = $${params.length}`;
    }
    if (session_id) {
      params.push(session_id);
      query += ` AND n.session_id = $${params.length}`;
    }
    if (date) {
      params.push(date);
      query += ` AND n.upload_date = $${params.length}`;
    }
    if (subject_id) {
      params.push(subject_id);
      query += ` AND (sc.subject_id = $${params.length} OR se.subject_id = $${params.length})`;
    }
    if (year) {
      params.push(year);
      query += ` AND (sc.year = $${params.length} OR se.year = $${params.length})`;
    }
    if (stream) {
      params.push(stream);
      query += ` AND (sc.stream = $${params.length} OR se.stream = $${params.length})`;
    }

    // Sort by upload_date descending
    query += ` ORDER BY n.upload_date DESC, n.created_at DESC`;

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const deleteNote = async (req, res) => {
  const { id } = req.params;
  const teacher_id = req.user.id;
  try {
    const { rows } = await pool.query(
      'DELETE FROM class_notes WHERE id = $1 AND teacher_id = $2 RETURNING *',
      [id, teacher_id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Note not found or unauthorized' });
    }
    res.json({ message: 'Note deleted successfully', deletedId: id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const renameNote = async (req, res) => {
  const { id } = req.params;
  const { file_name } = req.body;
  const teacher_id = req.user.id;
  try {
    const { rows } = await pool.query(
      'UPDATE class_notes SET file_name = $1 WHERE id = $2 AND teacher_id = $3 RETURNING *',
      [file_name, id, teacher_id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Note not found or unauthorized' });
    }
    res.json({ message: 'Note renamed successfully', note: rows[0] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
