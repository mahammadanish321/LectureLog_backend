import pool from '../config/database.config.js';

export const createPad = async (req, res) => {
  const { title, content_json } = req.body;
  const userId = req.user.id;
  const role = req.user.role?.toLowerCase();

  try {
    const ownerField = role === 'student' ? 'owner_student_id' : 'owner_teacher_id';
    const content = content_json ? JSON.stringify(content_json) : null;
    const result = await pool.query(
      `INSERT INTO writing_pads (title, content_json, ${ownerField}) VALUES ($1, $2, $3) RETURNING *`,
      [title || 'Untitled Pad', content, userId]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create pad error:', error);
    res.status(500).json({ message: 'Server error creating pad' });
  }
};

export const getAllPads = async (req, res) => {
  const userId = req.user.id;
  const role = req.user.role?.toLowerCase();

  try {
    const ownerField = role === 'student' ? 'owner_student_id' : 'owner_teacher_id';
    const result = await pool.query(
      `SELECT * FROM writing_pads WHERE ${ownerField} = $1 AND is_deleted = false ORDER BY updated_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get all pads error:', error);
    res.status(500).json({ message: 'Server error fetching pads' });
  }
};

export const getPadById = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const role = req.user.role?.toLowerCase();

  try {
    const ownerField = role === 'student' ? 'owner_student_id' : 'owner_teacher_id';
    const result = await pool.query(
      `SELECT * FROM writing_pads WHERE id = $1 AND ${ownerField} = $2 AND is_deleted = false`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Pad not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get pad error:', error);
    res.status(500).json({ message: 'Server error fetching pad' });
  }
};

export const getSharedPad = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM writing_pads WHERE id = $1 AND is_public = true AND is_deleted = false`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Pad not found or not public' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get shared pad error:', error);
    res.status(500).json({ message: 'Server error fetching shared pad' });
  }
};

export const updatePad = async (req, res) => {
  const { id } = req.params;
  const { title, content_json, is_public } = req.body;
  const userId = req.user.id;
  const role = req.user.role?.toLowerCase();

  try {
    const ownerField = role === 'student' ? 'owner_student_id' : 'owner_teacher_id';
    
    // Check if pad exists and is owned by user
    const checkResult = await pool.query(
      `SELECT id FROM writing_pads WHERE id = $1 AND ${ownerField} = $2 AND is_deleted = false`,
      [id, userId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ message: 'Pad not found or unauthorized' });
    }

    const result = await pool.query(
      `UPDATE writing_pads 
       SET title = COALESCE($1, title), 
           content_json = COALESCE($2, content_json), 
           is_public = COALESCE($3, is_public),
           updated_at = NOW() 
       WHERE id = $4 
       RETURNING *`,
      [title, content_json ? JSON.stringify(content_json) : null, is_public, id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update pad error:', error);
    res.status(500).json({ message: 'Server error updating pad' });
  }
};

export const deletePad = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const role = req.user.role?.toLowerCase();

  try {
    const ownerField = role === 'student' ? 'owner_student_id' : 'owner_teacher_id';
    
    const result = await pool.query(
      `UPDATE writing_pads SET is_deleted = true, updated_at = NOW() WHERE id = $1 AND ${ownerField} = $2 RETURNING id`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Pad not found or unauthorized' });
    }

    res.json({ message: 'Pad deleted successfully' });
  } catch (error) {
    console.error('Delete pad error:', error);
    res.status(500).json({ message: 'Server error deleting pad' });
  }
};
