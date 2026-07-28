import express from "express";
import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import cloudinary from "../config/cloudinary.config.js";
import { authenticateToken } from "../middleware/auth.middleware.js";
import { getMyGroups, getGroupMessages, uploadAttachment, getGroupStats, syncLegacyNodes, editMessage } from "../controllers/chat.controller.js";

const router = express.Router();

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'Merge/chat_attachments',
    resource_type: 'auto',
  },
});
const upload = multer({ storage });

router.use(authenticateToken);

router.get("/groups", getMyGroups);
router.get("/groups/:id/stats", getGroupStats);
router.get("/sync-legacy-nodes", syncLegacyNodes);
router.get("/messages/:groupId", getGroupMessages);
router.post("/upload", upload.array('attachments', 10), uploadAttachment);
router.patch("/messages/:id", editMessage);

export default router;
