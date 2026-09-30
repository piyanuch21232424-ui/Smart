import express from "express";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// ===== System Prompt =====
const SYSTEM_PROMPT = `คุณคือผู้เชี่ยวชาญด้านโรคไข้เลือดออกและป้องกันยุงลาย ชื่อ "หมอยุงลาย"
ตอบเป็นภาษาไทยเท่านั้น กระชับ ชัดเจน เป็นมิตร และถูกต้องตามข้อมูลทางการแพทย์

หน้าที่ของคุณ:
- อธิบายอาการ ระยะของโรค การป้องกัน (3 เก็บ + 5 ป.) การทำลายลูกน้ำ
- แนะนำเมื่อไหร่ควรไปโรงพยาบาล
- ห้ามแนะนำยาแอสไพรินหรือ NSAIDs
- ถ้าผู้ใช้มีอาการรุนแรง ให้แนะนำให้ไปพบแพทย์ทันที
- ตอบสั้น ๆ ไม่เกิน 300 คำ

ถ้าผู้ใช้ทักทายหรือถามไม่ชัด ให้แนะนำเมนู:
1. อาการไข้เลือดออก
2. วิธีป้องกันยุงลาย
3. ระยะของโรค
4. เมื่อไหร่ควรไปหาหมอ
5. วัคซีน
6. วิธีทำลายลูกน้ำ`;

// ===== เรียก Gemini =====
async function askGemini(userMessage) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: userMessage,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.4,
        maxOutputTokens: 800,
      },
    });
    return response.text || "ขออภัย ระบบมีปัญหา กรุณาลองใหม่นะครับ";
  } catch (error) {
    console.error("Gemini Error:", error.message);
    return "ขออภัย ระบบตอบไม่ได้ชั่วคราวครับ";
  }
}

// ===== ตอบกลับ LINE =====
async function replyLine(replyToken, text) {
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_TOKEN}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text }],
      }),
    });

    if (!res.ok) {
      console.error("LINE Error:", await res.text());
    } else {
      console.log("Reply sent successfully");
    }
  } catch (error) {
    console.error("Reply Error:", error.message);
  }
}

// ===== Webhook =====
app.post("/webhook", async (req, res) => {
  console.log("=== Webhook received ===");
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const events = req.body.events || [];

    for (const event of events) {
      if (event.type === "follow") {
        await replyLine(
          event.replyToken,
          `สวัสดีครับ ผมคือหมอยุงลาย 🦟\nแชทบอทป้องกันไข้เลือดออก\n\nพิมพ์คำถามได้เลย หรือพิมพ์ตัวเลข:\n1. อาการ\n2. วิธีป้องกัน\n3. ระยะโรค\n4. ไปหาหมอเมื่อไหร่\n5. วัคซีน\n6. ทำลายลูกน้ำ`
        );
        continue;
      }

      if (event.type === "message" && event.message?.type === "text") {
        const userText = event.message.text;
        console.log("User:", userText);

        const answer = await askGemini(userText);
        console.log("Bot:", answer);

        await replyLine(event.replyToken, answer);
      }
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Error:", error);
    res.status(200).send("OK");
  }
});

app.get("/", (req, res) => {
  res.send("Dengue Smart Chatbot is running 🦟");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
