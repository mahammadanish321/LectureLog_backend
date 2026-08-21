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
  const role = req.user.role?.toLowerCase() || 'student';

  try {
    const ownerField = role === 'student' ? 'owner_student_id' : 'owner_teacher_id';
    
    let userYear = null;
    let userStream = null;
    if (role === 'student') {
      const sRes = await pool.query('SELECT year, stream FROM students WHERE id = $1', [userId]);
      if (sRes.rows.length > 0) {
        userYear = sRes.rows[0].year;
        userStream = sRes.rows[0].stream;
      }
    }

    const result = await pool.query(
      `SELECT wp.*, 
              CASE WHEN wp.${ownerField} = $1 THEN true ELSE false END as is_owner
       FROM writing_pads wp
       LEFT JOIN pad_collaborators pc ON wp.id = pc.pad_id AND pc.user_id = $1
       WHERE wp.is_deleted = false 
         AND (
           wp.${ownerField} = $1 
           OR pc.id IS NOT NULL
           OR (
             wp.is_live_active = true AND (
               wp.target_audience_type = 'everyone'
               OR (
                 wp.target_audience_type = 'class' 
                 AND ($2::integer IS NULL OR wp.target_year IS NULL OR wp.target_year = $2)
                 AND ($3::text IS NULL OR wp.target_stream IS NULL OR LOWER(wp.target_stream) = LOWER($3))
               )
               OR (
                 wp.target_audience_type = 'individual' 
                 AND (wp.invited_user_ids::text LIKE '%' || $1::text || '%')
               )
             )
           )
         )
       GROUP BY wp.id
       ORDER BY wp.updated_at DESC`,
      [userId, userYear, userStream]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get all pads error:', error);
    res.status(500).json({ message: 'Server error fetching pads' });
  }
};

export const registerCollaborator = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const role = req.user.role?.toLowerCase();

  try {
    await pool.query(
      `INSERT INTO pad_collaborators (pad_id, user_id, user_role) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (pad_id, user_id, user_role) DO NOTHING`,
      [id, userId, role]
    );
    res.json({ message: 'Collaborator registered successfully' });
  } catch (error) {
    console.error('Register collaborator error:', error);
    res.status(500).json({ message: 'Server error registering collaborator' });
  }
};

export const getPadById = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const role = req.user.role?.toLowerCase();

  try {
    const ownerField = role === 'student' ? 'owner_student_id' : 'owner_teacher_id';
    const result = await pool.query(
      `SELECT wp.*, 
              CASE WHEN wp.${ownerField} = $1 THEN true ELSE false END as is_owner
       FROM writing_pads wp
       LEFT JOIN pad_collaborators pc ON wp.id = pc.pad_id AND pc.user_id = $1 AND pc.user_role = $2
       WHERE wp.id = $3 
         AND (wp.${ownerField} = $1 OR pc.id IS NOT NULL OR wp.is_public = true OR wp.is_live_active = true)
         AND wp.is_deleted = false`,
      [userId, role, id]
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
      `SELECT * FROM writing_pads WHERE id = $1 AND is_deleted = false`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Pad not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get shared pad error:', error);
    res.status(500).json({ message: 'Server error fetching shared pad' });
  }
};

export const updatePad = async (req, res) => {
  const { id } = req.params;
  const { 
    title, 
    content_json, 
    is_public, 
    is_live_active, 
    live_mode, 
    target_audience_type, 
    target_year, 
    target_stream, 
    invited_user_ids 
  } = req.body;
  const userId = req.user.id;
  const role = req.user.role?.toLowerCase();

  try {
    const ownerField = role === 'student' ? 'owner_student_id' : 'owner_teacher_id';
    
    // Check if user is owner, registered collaborator, or joining active session
    const checkResult = await pool.query(
      `SELECT wp.id, CASE WHEN wp.${ownerField} = $1 THEN true ELSE false END as is_owner
       FROM writing_pads wp
       LEFT JOIN pad_collaborators pc ON wp.id = pc.pad_id AND pc.user_id = $1 AND pc.user_role = $2
       WHERE wp.id = $3 
         AND (wp.${ownerField} = $1 OR pc.id IS NOT NULL OR wp.is_live_active = true OR wp.is_public = true)
         AND wp.is_deleted = false`,
      [userId, role, id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ message: 'Pad not found or unauthorized' });
    }

    const isOwner = checkResult.rows[0].is_owner;

    const result = await pool.query(
      `UPDATE writing_pads 
       SET title = COALESCE($1, title), 
           content_json = COALESCE($2, content_json), 
           is_public = CASE WHEN $11 = true THEN COALESCE($3, is_public) ELSE is_public END,
           is_live_active = CASE WHEN $11 = true THEN COALESCE($4, is_live_active) ELSE is_live_active END,
           live_mode = CASE WHEN $11 = true THEN COALESCE($5, live_mode) ELSE live_mode END,
           target_audience_type = CASE WHEN $11 = true THEN COALESCE($6, target_audience_type) ELSE target_audience_type END,
           target_year = CASE WHEN $11 = true THEN COALESCE($7, target_year) ELSE target_year END,
           target_stream = CASE WHEN $11 = true THEN COALESCE($8, target_stream) ELSE target_stream END,
           invited_user_ids = CASE WHEN $11 = true THEN COALESCE($9, invited_user_ids) ELSE invited_user_ids END,
           updated_at = NOW() 
       WHERE id = $10 
       RETURNING *`,
      [
        title, 
        content_json ? JSON.stringify(content_json) : null, 
        is_public, 
        is_live_active,
        live_mode,
        target_audience_type,
        target_year,
        target_stream,
        invited_user_ids ? JSON.stringify(invited_user_ids) : null,
        id,
        isOwner
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update pad error:', error);
    res.status(500).json({ message: 'Server error updating pad' });
  }
};

export const getLiveInvitations = async (req, res) => {
  const userId = req.user.id;
  const role = req.user.role?.toLowerCase();

  try {
    let studentYear = null;
    let studentStream = null;
    if (role === 'student') {
      const sRes = await pool.query(`SELECT year, stream FROM students WHERE id = $1`, [userId]);
      if (sRes.rows.length > 0) {
        studentYear = sRes.rows[0].year;
        studentStream = sRes.rows[0].stream;
      }
    }

    const result = await pool.query(
      `SELECT wp.*, 
              u.name as host_teacher_name, 
              st.name as host_student_name
       FROM writing_pads wp
       LEFT JOIN users u ON wp.owner_teacher_id = u.id
       LEFT JOIN students st ON wp.owner_student_id = st.id
       WHERE wp.is_live_active = true 
         AND wp.is_deleted = false
         AND (
           wp.target_audience_type = 'everyone'
           OR (wp.target_audience_type = 'class' AND wp.target_year = $2 AND wp.target_stream = $3)
           OR (wp.target_audience_type = 'individual' AND wp.invited_user_ids @> $4::jsonb)
         )
       ORDER BY wp.updated_at DESC`,
      [userId, studentYear, studentStream, JSON.stringify([userId])]
    );

    const formatted = result.rows.map(row => ({
      ...row,
      host_name: row.host_teacher_name || row.host_student_name || 'Collaborator'
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Get live invitations error:', error);
    res.status(500).json({ message: 'Server error fetching live invitations' });
  }
};

export const getCollaborationCandidates = async (req, res) => {
  const orgId = req.user.organization_id;

  try {
    const studentsRes = await pool.query(
      `SELECT id, name, email, roll_number, year, stream FROM students WHERE organization_id = $1 AND status = 'active' ORDER BY name ASC`,
      [orgId]
    );

    const teachersRes = await pool.query(
      `SELECT id, name, email FROM users WHERE organization_id = $1 AND status = 'active' ORDER BY name ASC`,
      [orgId]
    );

    const allCandidates = [
      ...teachersRes.rows.map(t => ({ id: t.id, raw_id: t.id, type: 'teacher', name: t.name, email: t.email, label: `${t.name} (Teacher)` })),
      ...studentsRes.rows.map(s => ({ id: s.id, raw_id: s.id, type: 'student', name: s.name, email: s.email, label: `${s.name} (${s.stream || 'Student'} - Yr ${s.year || 1})` }))
    ];

    res.json(allCandidates);
  } catch (error) {
    console.error('Get candidates error:', error);
    res.status(500).json({ message: 'Failed to fetch collaboration candidates' });
  }
};

export const deletePad = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const role = req.user.role?.toLowerCase();

  try {
    const ownerField = role === 'student' ? 'owner_student_id' : 'owner_teacher_id';
    
    // Check if user is the pad owner
    const ownerCheck = await pool.query(
      `SELECT id FROM writing_pads WHERE id = $1 AND ${ownerField} = $2 AND is_deleted = false`,
      [id, userId]
    );

    if (ownerCheck.rows.length > 0) {
      await pool.query(
        `UPDATE writing_pads SET is_deleted = true, updated_at = NOW() WHERE id = $1`,
        [id]
      );
      return res.json({ message: 'Pad deleted successfully' });
    } else {
      await pool.query(
        `DELETE FROM pad_collaborators WHERE pad_id = $1 AND user_id = $2 AND user_role = $3`,
        [id, userId, role]
      );
      return res.json({ message: 'Shared pad removed from your list' });
    }
  } catch (error) {
    console.error('Delete pad error:', error);
    res.status(500).json({ message: 'Server error deleting pad' });
  }
};
