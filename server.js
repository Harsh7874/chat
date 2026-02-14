import express from "express";
import http from "http";
import { Server } from "socket.io";
import pg from "pg";
import Redis from "ioredis";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

// ====== CONFIG ======
const PG_URL = "postgresql://postgres:erfre5f4r534@db.ynqkeqppmalfceiyszxu.supabase.co:5432/postgres"
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const PORT = process.env.PORT || 5000;

// ====== APP SETUP ======
const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ====== DB ======
const pool = new pg.Pool({ connectionString: PG_URL });

// Run schema migrations on startup
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id            BIGSERIAL PRIMARY KEY,
      conversation_id TEXT      NOT NULL,
      "from"        TEXT      NOT NULL,
      "to"          TEXT      NOT NULL,
      text          TEXT      NOT NULL,
      status        TEXT      NOT NULL DEFAULT 'sent'
                    CHECK (status IN ('sent', 'delivered', 'read')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Equivalent of Mongoose compound index { conversationId: 1, _id: -1 }
    -- Powers fast cursor-based pagination
    CREATE INDEX IF NOT EXISTS idx_messages_conv_id_desc
      ON messages (conversation_id, id DESC);

    -- Powers the /chats/:userId aggregation (finding all conversations for a user)
    CREATE INDEX IF NOT EXISTS idx_messages_from
      ON messages ("from");

    CREATE INDEX IF NOT EXISTS idx_messages_to
      ON messages ("to");

    -- Powers the chat_opened query: find unread messages { from, to, status != 'read' }
    CREATE INDEX IF NOT EXISTS idx_messages_from_to_status
      ON messages ("from", "to", status);
  `);
  console.log("PostgreSQL schema ready");
}

await initDb();

// ====== REDIS CLIENTS ======
const redisPub = new Redis(REDIS_URL);   // publish
const redisSub = new Redis(REDIS_URL);   // subscribe only
console.log("Connected to Redis");

// ====== ONLINE USERS MAP ======
const onlineUsers = new Map(); // memberstackId -> socketId

// ====== REST ROUTES ======

// GET /chats/:userId — list all unique chat partners, most recent first
app.get("/chats/:userId", async (req, res) => {
  const { userId } = req.params;

  // Equivalent to the Mongoose aggregation:
  //   match from|to = userId → project otherUser → group by otherUser → sort lastMessageAt desc
  const result = await pool.query(
    `SELECT
       CASE WHEN "from" = $1 THEN "to" ELSE "from" END AS other_user,
       MAX(created_at) AS last_message_at
     FROM messages
     WHERE "from" = $1 OR "to" = $1
     GROUP BY other_user
     ORDER BY last_message_at DESC`,
    [userId]
  );

  res.json(result.rows.map((r) => ({ userId: r.other_user })));
});

// DELETE /chats?user1=&user2= — delete conversation between two users
app.delete("/chats", async (req, res) => {
  const { user1, user2 } = req.query;
  if (!user1 || !user2) {
    return res.status(400).json({ error: "user1 and user2 required" });
  }

  await pool.query(
    `DELETE FROM messages
     WHERE ("from" = $1 AND "to" = $2)
        OR ("from" = $2 AND "to" = $1)`,
    [user1, user2]
  );

  res.json({ success: true });
});

// DELETE /chats/all/:userId — delete ALL messages for a user
app.delete("/chats/all/:userId", async (req, res) => {
  const { userId } = req.params;
  await pool.query(
    `DELETE FROM messages WHERE "from" = $1 OR "to" = $1`,
    [userId]
  );
  res.json({ success: true });
});

// GET /messages?user1=&user2=&before=&limit= — cursor-paginated message history
app.get("/messages", async (req, res) => {
  const { user1, user2, before, limit = 50 } = req.query;
  if (!user1 || !user2) {
    return res.status(400).json({ error: "user1 and user2 are required" });
  }

  const users = [user1, user2].sort();
  const conversationId = `${users[0]}_${users[1]}`;

  let queryText;
  let queryParams;

  if (before) {
    // Cursor pagination: load messages older than `before` id
    queryText = `
      SELECT id, conversation_id, "from", "to", text, status, created_at
      FROM messages
      WHERE conversation_id = $1
        AND id < $2
      ORDER BY id DESC
      LIMIT $3
    `;
    queryParams = [conversationId, before, Number(limit)];
  } else {
    queryText = `
      SELECT id, conversation_id, "from", "to", text, status, created_at
      FROM messages
      WHERE conversation_id = $1
      ORDER BY id DESC
      LIMIT $2
    `;
    queryParams = [conversationId, Number(limit)];
  }

  const result = await pool.query(queryText, queryParams);
  // result.rows are newest-first; reverse to oldest-to-newest (same as original)
  const messages = result.rows.reverse();

  res.json(messages);
});

// ====== SOCKET LOGIC ======
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("register", (memberstackId) => {
    onlineUsers.set(memberstackId, socket.id);
    socket.memberstackId = memberstackId;
    console.log("Registered:", memberstackId);
  });

  socket.on("chat_opened", async ({ from, to }) => {
    try {
      // Find sent/delivered messages that the recipient (to) has now opened
      const result = await pool.query(
        `SELECT id FROM messages
         WHERE "from" = $1 AND "to" = $2 AND status <> 'read'`,
        [from, to]
      );

      if (result.rows.length === 0) return;

      const ids = result.rows.map((r) => r.id);

      // 🚀 1) Notify sender IMMEDIATELY (before DB write)
      const senderSocketId = onlineUsers.get(from);
      if (senderSocketId) {
        ids.forEach((id) => {
          io.to(senderSocketId).emit("status_update", {
            messageId: id,
            status: "read",
          });
        });
      }

      // 🗄️ 2) Update DB in background (don't block UI)
      pool.query(
        `UPDATE messages SET status = 'read' WHERE id = ANY($1::bigint[])`,
        [ids]
      ).catch((err) => console.error("DB read update error:", err));

    } catch (err) {
      console.error("chat_opened error:", err);
    }
  });

  socket.on("send_message", async (data) => {
    try {
      const { from, to, text, tempId } = data;
      const users = [from, to].sort(); // stable order
      const conversationId = `${users[0]}_${users[1]}`;

      const result = await pool.query(
        `INSERT INTO messages (conversation_id, "from", "to", text, status, created_at)
         VALUES ($1, $2, $3, $4, 'sent', NOW())
         RETURNING *`,
        [conversationId, from, to, text]
      );

      const savedMsg = result.rows[0];

      // Send back to sender with real ID
      socket.emit("message_sent", { tempId, savedMsg });

      // Publish for delivery via Redis
      await redisPub.publish("chat", JSON.stringify(savedMsg));
    } catch (err) {
      console.error("Send message error:", err);
    }
  });

  socket.on("delivered", async ({ messageId }) => {
    try {
      const result = await pool.query(
        `UPDATE messages
         SET status = 'delivered'
         WHERE id = $1 AND status = 'sent'
         RETURNING *`,
        [messageId]
      );

      if (result.rowCount === 0) return; // already delivered/read, skip

      const msg = result.rows[0];
      const senderSocketId = onlineUsers.get(msg.from);
      if (senderSocketId) {
        io.to(senderSocketId).emit("status_update", {
          messageId: msg.id,
          status: "delivered",
        });
      }
    } catch (err) {
      console.error("Delivered error:", err);
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

// ====== BASIC ROUTE ======
app.get("/", (req, res) => {
  res.send("Fast Chat Server Running");
});

// ====== START SERVER ======
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
// postgre pass :  erfre5f4r534
