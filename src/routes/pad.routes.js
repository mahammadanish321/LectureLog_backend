import express from 'express';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { 
  createPad, 
  getAllPads, 
  getPadById, 
  updatePad, 
  deletePad,
  getSharedPad,
  getLiveInvitations,
  getCollaborationCandidates,
  registerCollaborator
} from '../controllers/pad.controller.js';

import { 
  attachDocument, 
  removeDocument,
  getPadDocuments
} from '../controllers/pad_document.controller.js';

import { askQuestion, getChatHistory } from '../controllers/rag.controller.js';

const router = express.Router();

// Public route for shared read-only pads
router.get('/shared/:id', getSharedPad);

router.use(authenticateToken);

router.post('/shared/:id/join', registerCollaborator);
router.get('/live-invitations', getLiveInvitations);
router.get('/candidates/list', getCollaborationCandidates);

router.post('/', createPad);
router.get('/user/all', getAllPads);
router.get('/:id', getPadById);
router.put('/:id', updatePad);
router.delete('/:id', deletePad);

// Smart Desk Pad Document Routes
router.get('/:id/documents', getPadDocuments);
router.post('/:id/documents', attachDocument);
router.delete('/:id/documents/:docId', removeDocument);

// RAG AI Query and Chat Routes
router.post('/:id/ask', askQuestion);
router.get('/:id/chats', getChatHistory);

export default router;
