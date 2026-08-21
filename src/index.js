import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import app from "./app.js";
import { testDatabaseConnection } from "./config/database.config.js";
import { initScheduler } from "./services/scheduler.service.js";
import { initAIServiceMonitor } from "./services/ai.service.js";
import { initCameraBackend } from "./services/camera.service.js";

dotenv.config();

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

import { initNotificationSockets } from "./services/notification.service.js";
import { initChatSockets } from "./services/chat.service.js";
import { initPadSockets } from "./services/pad.socket.service.js";

app.set("io", io);
initNotificationSockets(io);
initChatSockets(io);
initPadSockets(io);

const PORT = Number(process.env.PORT) || 3000;

const startServer = async () => {
  try {
    await testDatabaseConnection();
    console.log("Connected to PostgreSQL database.");

    initScheduler(app);
    
    if (process.env.DISABLE_AI_SPAWN !== 'true') {
      initAIServiceMonitor(app);
      initCameraBackend();
    } else {
      console.log('AI Spawning is disabled (Production Mode).');
    }

    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Merge backend running on port ${PORT} (0.0.0.0)`);
    });
  } catch (error) {
    console.error("Failed to start backend:", error);
    process.exit(1);
  }
};

startServer();
