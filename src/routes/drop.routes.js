import express from 'express';
import { authenticateToken } from '../middleware/auth.middleware.js';
import {
  createDrop,
  getAllDrops,
  getDropById,
  voteDrop,
  deleteDrop,
  createComment,
  voteComment,
  deleteComment
} from '../controllers/drop.controller.js';

const router = express.Router();

router.use(authenticateToken);

router.post('/', createDrop);
router.get('/', getAllDrops);
router.post('/comments/:commentId/vote', voteComment);
router.delete('/comments/:commentId', deleteComment);
router.get('/:id', getDropById);
router.post('/:id/vote', voteDrop);
router.delete('/:id', deleteDrop);
router.post('/:id/comments', createComment);

export default router;
