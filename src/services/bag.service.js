import pool from '../config/database.config.js';

export const syncNoteToBag = async ({
  teacher_id,
  subject_id,
  subject_name,
  year,
  stream,
  orgId,
  upload_date,
  file_url,
  file_name,
  mime_type,
  file_size
}) => {
  try {
    // We will create Bag folders for the teacher and for all opted-in students.
    // Structure: Class Notes -> Subject Name -> Date
    const createFolderStructure = async (owner_teacher_id, owner_student_id) => {
      const ownerQuery = owner_student_id ? `owner_student_id = $1` : `owner_teacher_id = $1`;
      const ownerVal = owner_student_id || owner_teacher_id;
      
      // 1. Get or Create "Class Notes" folder
      let classNotesFolderRes = await pool.query(
        `SELECT id FROM bag_folders WHERE ${ownerQuery} AND parent_id IS NULL AND name = 'Class Notes'`,
        [ownerVal]
      );
      
      let classNotesFolderId;
      if (classNotesFolderRes.rowCount === 0) {
        const res = await pool.query(
          `INSERT INTO bag_folders (name, parent_id, owner_teacher_id, owner_student_id, scope) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          ['Class Notes', null, owner_teacher_id, owner_student_id, 'personal']
        );
        classNotesFolderId = res.rows[0].id;
      } else {
        classNotesFolderId = classNotesFolderRes.rows[0].id;
      }

      // 2. Get or Create Subject Name folder
      let subjectFolderRes = await pool.query(
        `SELECT id FROM bag_folders WHERE ${ownerQuery} AND parent_id = $2 AND name = $3`,
        [ownerVal, classNotesFolderId, subject_name]
      );
      
      let subjectFolderId;
      if (subjectFolderRes.rowCount === 0) {
        const res = await pool.query(
          `INSERT INTO bag_folders (name, parent_id, owner_teacher_id, owner_student_id, scope) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [subject_name, classNotesFolderId, owner_teacher_id, owner_student_id, 'personal']
        );
        subjectFolderId = res.rows[0].id;
      } else {
        subjectFolderId = subjectFolderRes.rows[0].id;
      }

      // 3. Get or Create Date folder
      let dateFolderRes = await pool.query(
        `SELECT id FROM bag_folders WHERE ${ownerQuery} AND parent_id = $2 AND name = $3`,
        [ownerVal, subjectFolderId, upload_date]
      );
      
      let dateFolderId;
      if (dateFolderRes.rowCount === 0) {
        const res = await pool.query(
          `INSERT INTO bag_folders (name, parent_id, owner_teacher_id, owner_student_id, scope) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [upload_date, subjectFolderId, owner_teacher_id, owner_student_id, 'personal']
        );
        dateFolderId = res.rows[0].id;
      } else {
        dateFolderId = dateFolderRes.rows[0].id;
      }

      // 4. Create the file entry
      await pool.query(
        `INSERT INTO bag_files (folder_id, owner_teacher_id, owner_student_id, file_name, file_url, file_size, mime_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [dateFolderId, owner_teacher_id, owner_student_id, file_name, file_url, file_size || 0, mime_type || 'application/octet-stream']
      );
    };

    // Auto add for teacher
    await createFolderStructure(teacher_id, null);

    // Auto add for opted-in students
    if (subject_id) {
      // Find students in this org, year, stream with auto_bag_notes = true
      const studentsRes = await pool.query(
        `SELECT id FROM students WHERE organization_id = $1 AND year = $2 AND stream = $3 AND auto_bag_notes = true`,
        [orgId, year, stream]
      );

      // Async loop to create folders for each student
      const promises = studentsRes.rows.map(student => 
        createFolderStructure(null, student.id).catch(e => console.error(`Error auto-bagging for student ${student.id}:`, e))
      );
      await Promise.all(promises);
    }
    
  } catch (err) {
    console.error('Error syncing note to bag:', err);
  }
};
