import express from 'express';
import multer from 'multer';
import { registerStudent, getStudents, getMyAttendance, getMyStats, deleteStudent, updateStudent, getMyProfile, addStudentAngles } from '../controllers/student.controller.js';
import { authenticateToken, authorizeRole } from '../middleware/auth.middleware.js';

const upload = multer({ dest: 'uploads/' });
const router = express.Router();

router.post('/', authenticateToken, authorizeRole('teacher', 'admin'), upload.any(), registerStudent);
router.get('/public', getStudents);
router.get('/', authenticateToken, getStudents);
router.get('/me', authenticateToken, getMyProfile);
router.get('/profile', authenticateToken, getMyProfile);
router.get('/my-attendance', authenticateToken, getMyAttendance);
router.get('/my-stats', authenticateToken, getMyStats);
router.patch('/me/auto-bag-notes', authenticateToken, async (req, res) => {
  try {
    const { auto_bag_notes } = req.body;
    const { default: pool } = await import('../config/database.config.js');
    await pool.query('UPDATE students SET auto_bag_notes = $1 WHERE id = $2', [auto_bag_notes, req.user.id]);
    res.json({ message: 'Setting updated successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
router.delete('/:id', authenticateToken, authorizeRole('admin'), deleteStudent);
router.put('/:id', authenticateToken, authorizeRole('admin'), upload.any(), updateStudent);
router.patch('/:id/angles', authenticateToken, authorizeRole('teacher', 'admin'), upload.any(), addStudentAngles);

export default router;
