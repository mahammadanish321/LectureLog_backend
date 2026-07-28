import express from 'express';
import { authenticateToken } from '../middleware/auth.middleware.js';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import {
  getBagContents,
  createFolder,
  uploadFile,
  renameItem,
  deleteItem,
  restoreItem
} from '../controllers/bag.controller.js';

const router = express.Router();

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    // If it's an image, let Cloudinary handle it as an image. Everything else (PDF, Word, etc) MUST be raw to prevent corruption.
    const resource_type = file.mimetype.startsWith('image/') ? 'image' : 'raw';
    return {
      folder: 'lecturelog_bag',
      resource_type: resource_type
    };
  }
});
const upload = multer({ storage: storage });

router.use(authenticateToken);

// Using query params for folder_id is easier, or optional param
router.get('/', getBagContents); 
router.post('/folders', createFolder);
router.post('/files', upload.single('file'), uploadFile);
router.patch('/:type/:id/rename', renameItem);
router.patch('/files/:id/restore', restoreItem);
router.delete('/:type/:id', deleteItem);

export default router;
