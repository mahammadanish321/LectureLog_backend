import express from "express";
import { authenticateToken } from "../middleware/auth.middleware.js";
import { getMyGroups, getGroupMessages } from "../controllers/chat.controller.js";

const router = express.Router();

router.use(authenticateToken);

router.get("/groups", getMyGroups);
router.get("/messages/:groupId", getGroupMessages);

export default router;
