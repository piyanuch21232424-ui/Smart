import express from "express";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

// ===== ตั้งค่า =====
// ใช้โมเดลมาตรฐานเพื่อป้องกันปัญหา Invalid Model
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.0-flash";

const LINE_TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
const CHANNEL_SECRET = (process.env.LINE_CHANNEL_SECRET || "").trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || "").trim();

const MAX_TURNS = 6;            // จำนวนรอบสนทนาที่จำ
const SESSION_TTL_MS = 30 * 60 * 1000;  // ลืมบทสนทนาถ้าเงียบเกิน 30 นาที
const RATE_LIMIT_MS = 2000;     // ผู้ใช้ส่งได้ทุก 2 วินาที
const MAX_INPUT_CHARS = 1000;   // จำกัดความยาวข้อความผู้ใช้
const LINE_MAX_CHARS = 4800;    // LINE จำกัด 5,000 ตัวอักษรต่อข้อความ
const ATTEMPTS_PER_MODEL = 2;   // ลองกี่ครั้งต่อโมเดล
const RETRY_BASE_MS = 700;      // รอ 0.7s, 1.4s ระหว่างลองซ้ำ
const RETRYABLE_STATUS = [429, 500, 503, 504];

if (!GEMINI_KEY || !LINE_TOKEN || !CHANNEL_SECRET) {
  console.error("ขาดค่า env: GEMINI_API_KEY / LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET");
  process.exit(1);
}
console.log("ENV OK | model:", GEMINI_MODEL, "| fallback:", GEMINI_FALLBACK_MODEL);

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });

// ===== System Prompt =====
const SYSTEM_PROMPT = `
คุณคือแชทบอทผู้เชี่ยวชาญด้านโรคไข้เลือดออกและการป้องกันยุงลาย ชื่อ "หมอยุงลาย"
ให้ข้อมูลที่ถูกต้อง อ้างอิงตามแนวทางของกรมควบคุมโรค กระทรวงสาธารณสุข
ตอบเป็นภาษาไทย อธิบายอย่างละเอียด ครอบคลุมเนื้อหาเชิงลึก และเข้าใจง่าย

หน้าที่ของคุณ:
- อธิบายเจาะลึกเกี่ยวกับอาการ ระยะของโรค การป้องกัน (3 เก็บป้องกัน 3 โรค) การทำลายแหล่งเพาะพันธุ์ยุงลาย วัคซีน วงจรชีวิตยุง และข้อมูลทางการแพทย์ที่เกี่ยวข้อง
- แนะนำอย่างชัดเจนว่าเมื่อไหร่ควรไปพบแพทย์หรือโรงพยาบาล

ข้อจำกัดและความปลอดภัย:
- คุณให้ความรู้ทั่วไปและข้อมูลเชิงลึก ไม่ใช่การวินิจฉัยโรคเฉพาะบุคคล และไม่ใช่การแทนที่แพทย์
- ห้ามแนะนำยาแอสไพรินหรือยากลุ่ม NSAIDs (เช่น ไอบูโพรเฟน ไดโคลฟีแนค) ถ้าถามเรื่องลดไข้ ให้แนะนำพาราเซตามอลตามขนาดที่เหมาะสมและปรึกษาแพทย์
- ห้ามระบุขนาดยาเฉพาะรายบุคคล
- ถ้าผู้ใช้มีสัญญาณอันตราย ได้แก่ ปวดท้องมาก อาเจียนต่อเนื่อง เลือดออก (เช่น เลือดกำเดา อาเจียนหรือถ่ายเป็นเลือด ถ่ายดำ) ซึม กระสับกระส่าย มือเท้าเย็น ตัวเย็นเร็วหลังไข้ลด ให้เตือนไปโรงพยาบาลทันที ก่อนเนื้อหาอื่น
- ถ้าคำถามไม่เกี่ยวกับไข้เลือดออก ยุงลาย หรือโรคติดต่อนำโดยแมลง ให้ปฏิเสธอย่างสุภาพและชวนกลับมาเรื่องไข้เลือดออก

รูปแบบ:
- อธิบายให้ละเอียดและครบถ้วนที่สุดตามที่ผู้ใช้ถาม (ไม่มีการจำกัดจำนวนคำ)
- จัดย่อหน้าให้อ่านง่าย ใช้ขีด (-) หรืออีโมจิเป็นหัวข้อย่อย
- ห้ามใช้ Markdown (เช่น ** # หรือตาราง) เพราะหน้าต่างแชท LINE แสดงผลเครื่องหมายเหล่านี้ไม่ได้
`;

// ===== เมนูลัด =====
const MENU = {
  "1": { label: "อาการ", q: "ไข้เลือดออกมีอาการอย่างไรบ้าง" },
  "2": { label: "วิธีป้องกัน", q: "วิธีป้องกันยุงลายและไข้เลือดออกทำอย่างไรบ้าง (3 เก็บ + 5 ป.)" },
  "3": { label: "ระยะโรค", q: "ไข้เลือดออกมีกี่ระยะ แต่ละระยะเป็นอย่างไร" },
  "4": { label: "ไปหาหมอเมื่อไหร่", q: "เมื่อไหร่ควรไปโรงพยาบาลเมื่อสงสัยไข้เลือดออก มีสัญญาณอันตรายอะไรบ้าง" },
  "5": { label: "วัคซีน", q: "วัคซีนไข้เลือดออกมีไหม ใครควรฉีด" },
  "6": { label: "ทำลายลูกน้ำ", q: "วิธีกำจัดลูกน้ำยุงลายในบ้านทำอย่างไร" },
};

const quickReplyItems = Object.entries(MENU).map(([num, m]) => ({
  type: "action",
  action: { type: "message", label: `${num}. ${m.label}`.slice(0, 20), text: num },
}));

const DANGER_REGEX =
  /(ปวดท้องมาก|อาเจียนไม่หยุด|อาเจียนตลอด|อาเจียนเป็นเลือด|ถ่ายดำ|ถ่ายเป็นเลือด|เลือดออก|เลือดกำเดา|เลือดออกตามไรฟัน|มือเท้าเย็น|ตัวเย็น|ซึม|ไม่รู้สึกตัว|หมดสติ|หายใจลำบาก|ช็อก|ปัสสาวะน้อย|กระสับกระส่าย)/;

const DANGER_NOTICE =
  "⚠️ ข้อความของคุณมีอาการที่อาจเป็นสัญญาณอันตราย หากมีไข้สูงร่วมกับอาการเหล่านี้ (ปวดท้องมาก อาเจียนต่อเนื่อง เลือดออก ซึม มือเท้าเย็น) โดยเฉพาะช่วงไข้เริ่มลด ให้ไปโรงพยาบาลหรือโทร 1669 ทันที อย่ารอดูอาการที่บ้าน\n\n";

const DISCLAIMER = "\n\nℹ️ ข้อมูลนี้เพื่อความรู้ทั่วไป ไม่ใช่การวินิจฉัย หากกังวลควรพบแพทย์หรือโทร 1422";

// ===== ความจำบทสนทนา =====
const sessions = new Map();

function getSession(userId) {
  const now = Date.now();
  let s = sessions.get(userId);
  if (!s || now - s.updatedAt > SESSION_TTL_MS) {
    s = { history: [], updatedAt: now, lastMsgAt: 0 };
    sessions.set(userId, s);
  }
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, 10 * 60 * 1000).unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getStatus(err) {
  if (typeof err?.status === "number") return err.status;
  if (typeof err?.code === "number") return err.code;
  try {
    const parsed = JSON.parse(err?.message || "");
    return parsed?.error?.code;
  } catch {
    return undefined;
  }
}

// รวมฟังก์ชัน buildConfig ไว้เพียงที่เดียวและขยาย maxOutputTokens เป็น 8192
function buildConfig(model) {
  const config = {
    systemInstruction: SYSTEM_PROMPT,
    temperature: 0.4,
    maxOutputTokens: 8192,
  };
  
  if (model.startsWith("gemini-2.5")) {
    config.thinkingConfig = { thinkingBudget: 0 };
  }
  return config;
}

async function generateWithRetry(contents) {
  const models = [...new Set([GEMINI_MODEL, GEMINI_FALLBACK_MODEL])];
  let lastErr;

  for (const model of models) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: buildConfig(model),
        });
        if (model !== GEMINI_MODEL) console.log("[gemini] ใช้โมเดลสำรอง:", model);
        return response;
      } catch (err) {
        lastErr = err;
        const status = getStatus(err);
        console.error(`Gemini Error [${model}] attempt ${attempt + 1}:`, status, err?.message || err);
        if (!RETRYABLE_STATUS.includes(status)) break;
        if (attempt < ATTEMPTS_PER_MODEL - 1) await sleep(RETRY_BASE_MS * 2 ** attempt);
      }
    }
  }
  throw lastErr;
}

async function askGemini(userId, userMessage) {
  const session = getSession(userId);
  const contents = [
    ...session.history,
    { role: "user", parts: [{ text: userMessage }] },
  ];

  try {
    const response = await generateWithRetry(contents);
    const text = (response.text || "").trim();
    if (!text) return null;

    session.history.push({ role: "user", parts: [{ text: userMessage }] });
    session.history.push({ role: "model", parts: [{ text }] });
    if (session.history.length > MAX_TURNS * 2) {
      session.history = session.history.slice(-MAX_TURNS * 2);
    }
    session.updatedAt = Date.now();
    return text;
  } catch (error) {
    console.error("Gemini failed after retries:", error?.message || error);
    return null;
  }
}

function splitText(text, size = LINE_MAX_CHARS) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

async function replyLine(replyToken, text, { withMenu = true } = {}) {
  const chunks = splitText(text).slice(0, 5);
  const messages = chunks.map((t) => ({ type: "text", text: t }));
  if (withMenu) {
    messages[messages.length - 1].quickReply = { items: quickReplyItems };
  }

  try {
    const r = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_TOKEN}`,
      },
      body: JSON.stringify({ replyToken, messages }),
    });
    if (!r.ok) console.error("LINE reply error:", r.status, await r.text());
    else console.log("[reply] sent OK");
  } catch (e) {
    console.error("LINE reply exception:", e);
  }
}

async function showLoading(userId) {
  try {
    await fetch("https://api.line.me/v2/bot/chat/loading/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_TOKEN}`,
      },
      body: JSON.stringify({ chatId: userId, loadingSeconds: 20 }),
    });
  } catch {
    /* ไม่สำคัญ ข้ามได้ */
  }
}

function welcomeMessage() {
  return {
    type: "flex",
    altText: "สวัสดีครับ ผมคือหมอยุงลาย แชทบอทป้องกันไข้เลือดออก",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "🦟 หมอยุงลาย", weight: "bold", size: "xl" },
          {
            type: "text",
            text: "แชทบอทให้ความรู้เรื่องไข้เลือดออกและการป้องกันยุงลาย พิมพ์คำถามได้เลย หรือกดเมนูด้านล่าง",
            wrap: true,
            size: "sm",
            color: "#555555",
          },
          {
            type: "text",
            text: "ข้อมูลเพื่อความรู้ทั่วไป ไม่ใช่การวินิจฉัย หากมีไข้สูงร่วมกับปวดท้องมาก อาเจียนต่อเนื่อง หรือเลือดออก ให้ไปโรงพยาบาลทันที",
            wrap: true,
            size: "xs",
            color: "#C0392B",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: Object.entries(MENU).map(([num, m]) => ({
          type: "button",
          style: "secondary",
          height: "sm",
          action: { type: "message", label: `${num}. ${m.label}`.slice(0, 20), text: num },
        })),
      },
    },
  };
}

async function replyWelcome(replyToken) {
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_TOKEN}`,
      },
      body: JSON.stringify({ replyToken, messages: [welcomeMessage()] }),
    });
    if (!r.ok) console.error("LINE welcome error:", r.status, await r.text());
  } catch (e) {
    console.error("LINE welcome exception:", e);
  }
}

function verifySignature(rawBody, signature) {
  if (!rawBody || !signature) return false;
  const hash = crypto.createHmac("SHA256", CHANNEL_SECRET).update(rawBody).digest();
  const sig = Buffer.from(signature, "base64");
  return hash.length === sig.length && crypto.timingSafeEqual(hash, sig);
}

async function handleEvent(event) {
  if (event.type === "follow") {
    await replyWelcome(event.replyToken);
    return;
  }

  if (event.type !== "message") return;

  if (event.message.type !== "text") {
    await replyLine(event.replyToken, "ขออภัยครับ ตอนนี้ผมอ่านได้เฉพาะข้อความตัวอักษร ลองพิมพ์คำถามหรือเลือกเมนูได้เลย");
    return;
  }

  const userId = event.source?.userId || "anonymous";
  const raw = event.message.text.trim();
  const session = getSession(userId);

  const now = Date.now();
  if (now - session.lastMsgAt < RATE_LIMIT_MS) return;
  session.lastMsgAt = now;

  if (/^(สวัสดี|หวัดดี|hi|hello|เมนู|menu|เริ่ม)/i.test(raw)) {
    await replyWelcome(event.replyToken);
    return;
  }

  if (/^(ล้างประวัติ|เริ่มใหม่|reset)$/i.test(raw)) {
    sessions.delete(userId);
    await replyLine(event.replyToken, "ล้างประวัติการสนทนาแล้วครับ เริ่มถามใหม่ได้เลย");
    return;
  }

  let question = MENU[raw]?.q || raw;

  if (question.length > MAX_INPUT_CHARS) {
    await replyLine(event.replyToken, `ข้อความยาวเกินไปครับ กรุณาพิมพ์ไม่เกิน ${MAX_INPUT_CHARS} ตัวอักษร`);
    return;
  }

  if (event.source?.type === "user") showLoading(userId);

  const answer = await askGemini(userId, question);

  if (!answer) {
    const fallback = DANGER_REGEX.test(raw)
      ? DANGER_NOTICE + "ขณะนี้ระบบตอบไม่ได้ชั่วคราว กรุณาโทร 1669 หรือไปสถานพยาบาลที่ใกล้ที่สุด"
      : "ขออภัยครับ ระบบตอบไม่ได้ชั่วคราว กรุณาลองใหม่อีกครั้ง หรือสอบถามสายด่วนกรมควบคุมโรค 1422";
    await replyLine(event.replyToken, fallback);
    return;
  }

  let finalText = answer;
  if (DANGER_REGEX.test(raw)) finalText = DANGER_NOTICE + finalText;

  if (/(อาการ|หมอ|โรงพยาบาล|ยา|ไข้|วัคซีน)/.test(raw + question)) {
    finalText += DISCLAIMER;
  }

  await replyLine(event.replyToken, finalText);
}

app.post("/webhook", (req, res) => {
  const signature = req.headers["x-line-signature"];
  console.log("[webhook] hit | has signature:", !!signature, "| events:", req.body?.events?.length ?? 0);

  if (!verifySignature(req.rawBody, signature)) {
    console.error("[webhook] INVALID SIGNATURE -> ตรวจ LINE_CHANNEL_SECRET ใน Render ให้ตรงกับ Channel secret ใน LINE Developers");
    return res.status(401).send("Invalid signature");
  }

  res.status(200).send("OK");

  const events = req.body.events || [];
  for (const event of events) {
    if (event.deliveryContext?.isRedelivery) continue;
    handleEvent(event).catch((e) => console.error("handleEvent error:", e));
  }
});

app.get("/", (req, res) => res.send("Dengue Chatbot with Gemini is running 🦟"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
