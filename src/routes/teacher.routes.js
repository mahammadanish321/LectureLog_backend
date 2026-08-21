import express from 'express';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.middleware.js';
import {
  registerTeacher,
  updateTeacher,
  getTeachers,
  deleteTeacher,
  getMyProfile,
  addTeacherAngles
} from '../controllers/teacher.controller.js';

const router = express.Router();

// Setup Multer for saving uploaded teacher images temporarily
const upload = multer({ dest: 'uploads/' });

router.get('/me', authenticateToken, getMyProfile);
router.get('/profile', authenticateToken, getMyProfile);
router.post('/', authenticateToken, upload.any(), registerTeacher);
router.put('/:id', authenticateToken, upload.any(), updateTeacher);
router.get('/', authenticateToken, getTeachers);
router.delete('/:id', authenticateToken, deleteTeacher);
router.patch('/:id/angles', authenticateToken, upload.any(), addTeacherAngles);

export default router;
