import express from 'express';
import multer from 'multer';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import cloudinary from '../config/cloudinary.config.js';
import { authenticateToken } from '../middleware/auth.middleware.js';
import {
  createDrop,
  getAllDrops,
  getDropById,
  voteDrop,
  deleteDrop,
  restoreDrop,
  toggleHideAdminDrop,
  updateDrop,
  createComment,
  voteComment,
  deleteComment,
  uploadAttachment
} from '../controllers/drop.controller.js';

const router = express.Router();

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const resource_type = (file.mimetype && file.mimetype.startsWith('image/')) ? 'image' : 'raw';
    return {
      folder: 'Merge/drop_attachments',
      resource_type: resource_type
    };
  }
});
const upload = multer({ storage });

router.use(authenticateToken);

router.post('/upload', upload.array('files', 10), uploadAttachment);
router.post('/', createDrop);
router.get('/', getAllDrops);
router.put('/:id', updateDrop);
router.post('/comments/:commentId/vote', voteComment);
router.delete('/comments/:commentId', deleteComment);
router.get('/:id', getDropById);
router.post('/:id/vote', voteDrop);
router.delete('/:id', deleteDrop);
router.post('/:id/restore', restoreDrop);
router.post('/:id/hide-admin', toggleHideAdminDrop);
router.post('/:id/comments', createComment);

export default router;
