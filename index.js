import express from "express";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ===== ตรวจสอบ Environment Variables =====
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

if (!GEMINI_API_KEY) {
  console.error("❌ ไม่พบ GEMINI_API_KEY");
}
if (!LINE_TOKEN) {
  console.error("❌ ไม่พบ LINE_CHANNEL_ACCESS_TOKEN");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ===== System Prompt =====
const SYSTEM_PROMPT = `คุณคือผู้เชี่ยวชาญด้านโรคไข้เลือดออกและป้องกันยุงลาย ชื่อ "หมอยุงลาย"
ตอบเป็นภาษาไทยเท่านั้น กระชับ ชัดเจน เป็นมิตร และถูกต้องตามข้อมูลทางการแพทย์

หน้าที่ของคุณ:
- อธิบายอาการ ระยะของโรค การป้องกันด้วยหลัก 3 เก็บ + 5 ป.
- แนะนำวิธีทำลายลูกน้ำยุงลาย
- บอกเมื่อไหร่ควรไปโรงพยาบาล
- ห้ามแนะนำยาแอสไพริน หรือ NSAIDs
- ถ้าผู้ใช้มีอาการรุนแรง ให้แนะนำไปพบแพทย์ทันที
- ตอบสั้น ๆ ไม่เกิน 300 คำ

ถ้าผู้ใช้ทักทายหรือถามไม่ชัดเจน ให้แนะนำเมนูดังนี้:
1. อาการไข้เลือดออก
2. วิธีป้องกันยุงลาย
3. ระยะของโรค
4. เมื่อไหร่ควรไปหาหมอ
5. วัคซีนไข้เลือดออก
6. วิธีทำลายลูกน้ำ`;

// ===== เรียก Gemini =====
async function askGemini(userMessage) {
  try {
    console.log("กำลังเรียก Gemini...");

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash", // โมเดลที่เสถียร
      contents: userMessage,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.4,
        maxOutputTokens: 800,
      },
    });

    const answer = response.text;
    console.log("Gemini ตอบ:", answer);
    return answer || "ขออภัย ไม่สามารถสร้างคำตอบได้ครับ";
  } catch (error) {
    console.error("❌ Gemini Error:", error.message || error);
    return "ขออภัย ระบบตอบไม่ได้ชั่วคราว กรุณาลองใหม่อีกครั้งนะครับ";
  }
}

// ===== ตอบกลับ LINE =====
async function replyLine(replyToken, text) {
  try {
    const response = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_TOKEN}`,
      },
      body: JSON.stringify({
        replyToken: replyToken,
        messages: [
          {
            type: "text",
            text: text,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ LINE Reply Error:", errorText);
    } else {
      console.log("✅ ตอบกลับ LINE สำเร็จ");
    }
  } catch (error) {
    console.error("❌ Reply Error:", error.message);
  }
}

// ===== Webhook =====
app.post("/webhook", async (req, res) => {
  console.log("========== ได้รับ Webhook ==========");

  try {
    const events = req.body.events || [];

    for (const event of events) {
      // เมื่อมีคนเพิ่มเพื่อน
      if (event.type === "follow") {
        const welcomeMessage = `สวัสดีครับ ผมคือหมอยุงลาย 🦟
แชทบอทป้องกันไข้เลือดออก

พิมพ์คำถามได้เลย หรือพิมพ์ตัวเลข:
1. อาการไข้เลือดออก
2. วิธีป้องกันยุงลาย
3. ระยะของโรค
4. เมื่อไหร่ควรไปหาหมอ
5. วัคซีน
6. วิธีทำลายลูกน้ำ`;

        await replyLine(event.replyToken, welcomeMessage);
        continue;
      }

      // เมื่อมีคนส่งข้อความ
      if (event.type === "message" && event.message?.type === "text") {
        const userText = event.message.text;
        console.log("ผู้ใช้พิมพ์:", userText);

        const answer = await askGemini(userText);
        await replyLine(event.replyToken, answer);
      }
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Webhook Error:", error);
    res.status(200).send("OK");
  }
});

// หน้าแรกสำหรับทดสอบ
app.get("/", (req, res) => {
  res.send(`
    <h1>🦟 Dengue Smart Chatbot</h1>
    <p>บอทกำลังทำงานปกติ</p>
    <p>เวลาปัจจุบัน: ${new Date().toLocaleString("th-TH")}</p>
  `);
});

// เริ่มเซิร์ฟเวอร์
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server ทำงานที่ port ${PORT}`);
});
