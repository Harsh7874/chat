import express from "express";
import http from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import Redis from "ioredis";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

// ====== CONFIG ======
const MONGO_URL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017/fastchat";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const PORT = process.env.PORT || 5000;

// ====== APP SETUP ======
const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ====== DB ======
await mongoose.connect(MONGO_URL);
console.log("Connected to MongoDB");

// Message Schema
const MessageSchema = new mongoose.Schema({
  from: String,
  to: String,
  text: String,
  createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model("Message", MessageSchema);

// ====== REDIS CLIENTS ======
const redisPub = new Redis(REDIS_URL);    // publish + queue push
const redisSub = new Redis(REDIS_URL);    // subscribe only
const redisQueue = new Redis(REDIS_URL);  // BRPOP worker

console.log("Connected to Redis");

// ====== ONLINE USERS MAP ======
const onlineUsers = new Map(); // memberstackId -> socketId

// ====== SOCKET LOGIC ======
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("register", (memberstackId) => {
    onlineUsers.set(memberstackId, socket.id);
    socket.memberstackId = memberstackId;
    console.log("Registered:", memberstackId);
  });

  socket.on("send_message", async (data) => {
    try {
      const { from, to, text } = data;

      const msg = {
        from,
        to,
        text,
        createdAt: new Date()
      };

      // 1) Publish to Redis for instant delivery
      await redisPub.publish("chat", JSON.stringify(msg));

      // 2) Push to Redis queue for DB saving
      await redisPub.lpush("mongo_save_queue", JSON.stringify(msg));
    } catch (err) {
      console.error("Send message error:", err);
    }
  });

  socket.on("disconnect", () => {
    if (socket.memberstackId) {
      onlineUsers.delete(socket.memberstackId);
    }
    console.log("Disconnected:", socket.id);
  });
});

// ====== REDIS SUBSCRIBER (REAL-TIME DELIVERY) ======
await redisSub.subscribe("chat");

redisSub.on("message", (channel, message) => {
  if (channel !== "chat") return;

  const msg = JSON.parse(message);
  const receiverSocketId = onlineUsers.get(msg.to);

  if (receiverSocketId) {
    io.to(receiverSocketId).emit("new_message", msg);
  }
});

// ====== BACKGROUND WORKER (SAVE TO MONGO) ======
async function mongoSaverWorker() {
  console.log("Mongo saver worker started...");

  while (true) {
    try {
      // Use redisQueue, NOT redisSub
      const result = await redisQueue.brpop("mongo_save_queue", 0);
      const msg = JSON.parse(result[1]);

      await Message.create(msg);
      console.log("Saved to Mongo:", msg.text);
    } catch (err) {
      console.error("Mongo saver error:", err);
    }
  }
}

mongoSaverWorker();

// ====== BASIC ROUTE ======
app.get("/", (req, res) => {
  res.send("Fast Chat Server Running");
});


app.get("/messages", async (req, res) => {
  const { user1, user2 } = req.query;

  if (!user1 || !user2) {
    return res.status(400).json({ error: "user1 and user2 are required" });
  }

  const messages = await Message.find({
    $or: [
      { from: user1, to: user2 },
      { from: user2, to: user1 }
    ]
  }).sort({ createdAt: 1 });

  res.json(messages);
});


// ====== START SERVER ======
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
