import pool from '../config/database.config.js';

// Helper to determine if user is teacher or student
const getOwnerFields = (req) => {
  if (req.user.role === 'student') {
    return { owner_student_id: req.user.id, owner_teacher_id: null };
  }
  return { owner_teacher_id: req.user.id, owner_student_id: null };
};

const getOwnerQuery = (req) => {
  if (req.user.role === 'student') {
    return `owner_student_id = $1`;
  }
  return `owner_teacher_id = $1`;
};

export const getBagContents = async (req, res) => {
  try {
    const { folder_id, is_trash } = req.query;
    const ownerQuery = getOwnerQuery(req);
    const userId = req.user.id;
    const params = [userId];

    if (is_trash === 'true') {
      const filesQuery = `SELECT * FROM bag_files WHERE ${ownerQuery} AND is_deleted = true ORDER BY file_name ASC`;
      const filesResult = await pool.query(filesQuery, params);
      return res.json({ folders: [], files: filesResult.rows });
    }

    let foldersQuery = `SELECT * FROM bag_folders WHERE ${ownerQuery} AND parent_id `;
    let filesQuery = `SELECT * FROM bag_files WHERE ${ownerQuery} AND is_deleted = false AND folder_id `;

    if (folder_id && folder_id !== 'root') {
      foldersQuery += `= $2`;
      filesQuery += `= $2`;
      params.push(folder_id);
    } else {
      foldersQuery += `IS NULL`;
      filesQuery += `IS NULL`;
    }

    foldersQuery += ` ORDER BY name ASC`;
    filesQuery += ` ORDER BY file_name ASC`;

    const [foldersResult, filesResult] = await Promise.all([
      pool.query(foldersQuery, params),
      pool.query(filesQuery, params)
    ]);

    res.json({
      folders: foldersResult.rows,
      files: filesResult.rows
    });
  } catch (error) {
    console.error('Error fetching bag contents:', error);
    res.status(500).json({ message: 'Error fetching bag contents', error: error.message });
  }
};

export const createFolder = async (req, res) => {
  try {
    const { name, parent_id, scope } = req.body;
    const { owner_teacher_id, owner_student_id } = getOwnerFields(req);

    const result = await pool.query(
      `INSERT INTO bag_folders (name, parent_id, owner_teacher_id, owner_student_id, scope) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, parent_id || null, owner_teacher_id, owner_student_id, scope || 'personal']
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating folder:', error);
    res.status(500).json({ message: 'Error creating folder', error: error.message });
  }
};

export const uploadFile = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const { folder_id } = req.body;
    const { owner_teacher_id, owner_student_id } = getOwnerFields(req);

    const file_name = req.file.originalname;
    const file_url = req.file.path;
    const file_size = req.file.size || 0; // Cloudinary multer storage might not always give size synchronously in all versions, but we fallback to 0 if not present
    const mime_type = req.file.mimetype;

    const result = await pool.query(
      `INSERT INTO bag_files (folder_id, owner_teacher_id, owner_student_id, file_name, file_url, file_size, mime_type) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [folder_id === 'root' ? null : (folder_id || null), owner_teacher_id, owner_student_id, file_name, file_url, file_size, mime_type]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ message: 'Error uploading file', error: error.message });
  }
};

export const renameItem = async (req, res) => {
  try {
    const { type, id } = req.params; // type = 'folder' or 'file'
    const { newName } = req.body;
    const ownerQuery = getOwnerQuery(req);
    const userId = req.user.id;

    if (type === 'folder') {
      const result = await pool.query(
        `UPDATE bag_folders SET name = $1 WHERE id = $2 AND ${ownerQuery} RETURNING *`,
        [newName, id, userId]
      );
      if (result.rows.length === 0) return res.status(404).json({ message: 'Folder not found' });
      return res.json(result.rows[0]);
    } else if (type === 'file') {
      const result = await pool.query(
        `UPDATE bag_files SET file_name = $1 WHERE id = $2 AND ${ownerQuery} AND is_deleted = false RETURNING *`,
        [newName, id, userId]
      );
      if (result.rows.length === 0) return res.status(404).json({ message: 'File not found' });
      return res.json(result.rows[0]);
    } else {
      return res.status(400).json({ message: 'Invalid type' });
    }
  } catch (error) {
    console.error('Error renaming item:', error);
    res.status(500).json({ message: 'Error renaming item', error: error.message });
  }
};

export const deleteItem = async (req, res) => {
  try {
    const { type, id } = req.params;
    const ownerQuery = getOwnerQuery(req);
    const userId = req.user.id;

    if (type === 'folder') {
      // Actually delete folder for now, or you could do soft delete. To keep it simple, hard delete cascades to files in PostgreSQL.
      // Wait, if it cascades, it hard deletes the files too. We'll stick to hard delete for folders and files for simplicity unless we specifically implement a trash view.
      // Let's implement soft delete for files. For folders, maybe soft delete too, but let's just do hard delete for now to be safe, or just soft delete.
      // The schema for folders doesn't have is_deleted. So we HARD DELETE folders.
      const result = await pool.query(
        `DELETE FROM bag_folders WHERE id = $1 AND ${ownerQuery} RETURNING *`,
        [id, userId]
      );
      if (result.rows.length === 0) return res.status(404).json({ message: 'Folder not found' });
      return res.json({ message: 'Folder deleted' });
    } else if (type === 'file') {
      const result = await pool.query(
        `UPDATE bag_files SET is_deleted = true WHERE id = $1 AND ${ownerQuery} RETURNING *`,
        [id, userId]
      );
      if (result.rows.length === 0) return res.status(404).json({ message: 'File not found' });
      return res.json({ message: 'File moved to trash' });
    } else {
      return res.status(400).json({ message: 'Invalid type' });
    }
  } catch (error) {
    console.error('Error deleting item:', error);
    res.status(500).json({ message: 'Error deleting item', error: error.message });
  }
};

export const restoreItem = async (req, res) => {
  try {
    const { id } = req.params;
    const ownerQuery = getOwnerQuery(req);
    const userId = req.user.id;

    // Only files can be soft deleted/restored right now
    const result = await pool.query(
      `UPDATE bag_files SET is_deleted = false WHERE id = $1 AND ${ownerQuery} RETURNING *`,
      [id, userId]
    );

    if (result.rows.length === 0) return res.status(404).json({ message: 'File not found in trash' });
    return res.json({ message: 'File restored', file: result.rows[0] });
  } catch (error) {
    console.error('Error restoring item:', error);
    res.status(500).json({ message: 'Error restoring item', error: error.message });
  }
};
