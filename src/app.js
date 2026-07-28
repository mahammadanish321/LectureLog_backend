import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";

// Route imports
import studentRoutes from "./routes/student.routes.js";
import sessionRoutes from "./routes/session.routes.js";
import attendanceRoutes from "./routes/db-attendance.routes.js";
import recheckRoutes from "./routes/db-recheck.routes.js";
import agentRoutes from "./routes/agent.routes.js";
import chatRoutes from "./routes/chat.routes.js";
import recognitionRoutes from "./routes/db-recognition.routes.js";
import authRoutes from "./routes/db-auth.routes.js";
import scheduleRoutes from "./routes/schedule.routes.js";
import subjectRoutes from "./routes/subject.routes.js";
import teacherRoutes from "./routes/teacher.routes.js";
import classroomRoutes from "./routes/classroom.routes.js";
import timeSlotsRoutes from "./routes/time-slots.routes.js";
import organizationRoutes from "./routes/organization.routes.js";
import notificationRoutes from "./routes/notification.routes.js";
import appVersionRoutes from "./routes/app-version.routes.js";
import searchRoutes from "./routes/search.routes.js";
import requestsRoutes from "./routes/requests.routes.js";
import notesRoutes from "./routes/notes.routes.js";
import bagRoutes from "./routes/bag.routes.js";
import padRoutes from "./routes/pad.routes.js";
import dropRoutes from "./routes/drop.routes.js";
import { apiErrorHandler, notFoundHandler } from "./middleware/errorHandler.js";

// Setup directory paths for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- GLOBAL MIDDLEWARE ---
app.use(cors({ origin: '*', credentials: true }));
app.use(helmet({ crossOriginResourcePolicy: false })); // Security headers (modified to allow image serving)
app.use(morgan("dev")); // HTTP request logger
app.use(express.json({ limit: "10mb" })); // Parse JSON payloads
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

// --- STATIC FILES ---
// Serve the 'public' folder to the internet so the frontend can load student images
app.use("/public", express.static(path.join(process.cwd(), "public")));

// --- HEALTH CHECK ---
app.get("/health", (_req, res) => {
  res.status(200).json({ success: true, message: "Server is healthy" });
});

// --- API ROUTES ---
app.use("/api/students", studentRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/recheck", recheckRoutes);
app.use("/api/agents", agentRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/recognition", recognitionRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/schedules", scheduleRoutes);
app.use("/api/subjects", subjectRoutes);
app.use("/api/teachers", teacherRoutes);
app.use("/api/classrooms", classroomRoutes);
app.use("/api/time_slots", timeSlotsRoutes);
app.use("/api/organizations", organizationRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/app-version", appVersionRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/requests", requestsRoutes);
app.use("/api/notes", notesRoutes);
app.use("/api/bag", bagRoutes);
app.use("/api/pads", padRoutes);
app.use("/api/drops", dropRoutes);

// --- ERROR HANDLING ---
// These must be at the very end to catch unresolved routes or crashes
app.use(notFoundHandler);
app.use(apiErrorHandler);

export default app;
