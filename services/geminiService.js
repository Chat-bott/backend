const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error(
    "Gemini API key is not configured. Please set GEMINI_API_KEY in your .env file"
  );
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

const getModel = () => {
  try {
    return genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  } catch (error) {
    console.warn("gemini-2.5-flash not available, using gemini-pro");
    return genAI.getGenerativeModel({ model: "gemini-pro" });
  }
};

// ✅ Deterministic parsing so we don't depend on Gemini behavior
const parseFillFromUser = (text) => {
  const t = String(text || "").trim();
  if (!t) return [];

  const out = [];
  const re =
    /\b(?:fill|add|set)\s+(name|email|message|search)\s*(?:field)?\s*(?:as|to|=)?\s*/gi;

  const hits = [];
  let m;

  while ((m = re.exec(t)) !== null) {
    hits.push({
      field: String(m[1] || "").toLowerCase(),
      matchIndex: m.index,
      valueStart: re.lastIndex,
    });
  }

  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].valueStart;
    const end = i + 1 < hits.length ? hits[i + 1].matchIndex : t.length;

    let value = t.slice(start, end).trim();
    value = value.replace(/^[,:-]\s*/, "");
    value = value.replace(/[,\s]+$/, "");

    if (value) out.push({ field: hits[i].field, value });
  }

  // Dedup (last wins)
  const final = {};
  for (const x of out) final[x.field] = x.value;

  return Object.entries(final).map(([field, value]) => ({ field, value }));
};

const processMessage = async (
  userMessage,
  conversationHistory = [],
  pageContent = null
) => {
  try {
    const model = getModel();

    const hasSearch = !!pageContent?.search?.exists;

    const systemPrompt = `You are a helpful co-browsing assistant for a portfolio website.
You can help users explore the website by answering questions and performing actions.

Current page structure:
- Sections: ${pageContent?.sections?.map((s) => s.id).join(", ") || "N/A"}
- Projects: ${pageContent?.projects?.length || 0} projects available
- Contact form available
- Search bar: ${hasSearch ? "AVAILABLE (field: search)" : "UNKNOWN/NOT FOUND"}

AVAILABLE ACTIONS (output one or more ACTION tags when UI should act):

- [ACTION:scroll_to_section:<sectionId>]  sectionId: home | about | projects | contact
- [ACTION:scroll_page:<direction>]        direction: up | down | top | bottom

Fill inputs:
- [ACTION:fill_input:{"field":"name","value":"Ved"}]
- [ACTION:fill_input:{"field":"email","value":"ved@gmail.com"}]
- [ACTION:fill_input:{"field":"message","value":"Hello"}]
- [ACTION:fill_input:{"field":"search","value":"react projects"}]

Rules:
- If the user asks to fill a field, you MUST output the fill_input ACTION tag(s).
- Do not claim fields don't exist if Search bar is AVAILABLE.
- Keep normal text separate from ACTION tags.
- Do NOT wrap JSON in backticks.

User message: "${userMessage}"
Respond naturally, and include ACTION tags when needed.`;

    let history = [];
    if (conversationHistory.length > 0) {
      const recentHistory = conversationHistory.slice(-6);

      const geminiHistory = recentHistory.map((msg) => ({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      }));

      let startIndex = 0;
      while (
        startIndex < geminiHistory.length &&
        geminiHistory[startIndex].role === "model"
      ) {
        startIndex++;
      }

      history = geminiHistory.slice(startIndex);

      const cleanedHistory = [];
      for (let i = 0; i < history.length; i++) {
        const current = history[i];
        const previous = cleanedHistory[cleanedHistory.length - 1];
        if (!previous || previous.role !== current.role) {
          cleanedHistory.push(current);
        }
      }
      history = cleanedHistory;
    }

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(systemPrompt);
    const response = await result.response;

    const rawText = response.text();

    const allowedSections = new Set(["home", "about", "projects", "contact"]);
    const allowedDirections = new Set(["up", "down", "top", "bottom"]);
    const allowedFields = new Set(["name", "email", "message", "search"]);

    const actions = [];

    // Extract actions from Gemini output
    let m;

    const sectionRe = /\[ACTION:scroll_to_section:([a-zA-Z0-9_-]+)\]/g;
    while ((m = sectionRe.exec(rawText)) !== null) {
      const sectionId = String(m[1] || "").toLowerCase();
      if (allowedSections.has(sectionId)) {
        actions.push({ type: "scroll_to_section", data: { sectionId } });
      }
    }

    const pageRe = /\[ACTION:scroll_page:([a-zA-Z0-9_-]+)\]/g;
    while ((m = pageRe.exec(rawText)) !== null) {
      const direction = String(m[1] || "").toLowerCase();
      if (allowedDirections.has(direction)) {
        actions.push({ type: "scroll_page", data: { direction } });
      }
    }

    const fillRe = /\[ACTION:fill_input:(\{.*?\})\]/g;
    while ((m = fillRe.exec(rawText)) !== null) {
      try {
        const obj = JSON.parse(m[1]);
        const field = obj?.field ? String(obj.field).toLowerCase() : "";
        const selector = obj?.selector ? String(obj.selector) : "";
        const value = obj?.value ?? "";

        if (selector) actions.push({ type: "fill_input", data: { selector, value } });
        else if (field && allowedFields.has(field))
          actions.push({ type: "fill_input", data: { field, value } });
      } catch {}
    }

    // ✅ Forced actions from user text (so Gemini can't block you)
    const forcedFills = parseFillFromUser(userMessage).filter((x) =>
      allowedFields.has(x.field)
    );

    // merge (avoid duplicates)
    for (const f of forcedFills) {
      const exists = actions.some(
        (a) => a.type === "fill_input" && a.data?.field === f.field
      );
      if (!exists) {
        actions.push({ type: "fill_input", data: { field: f.field, value: f.value } });
      }
    }

    // Clean visible text
    let cleanedText = rawText.replace(/\[ACTION:[^\]]+\]/g, "").trim();

    // If user asked to fill something, don't return Gemini's useless denial text
    if (forcedFills.length > 0) {
      const summary = forcedFills.map((x) => x.field).join(", ");
      cleanedText = `Done. Filled: ${summary}.`;
    }

    return { text: cleanedText, actions };
  } catch (error) {
    console.error("Gemini API Error:", error);
    return {
      text: `Error: ${error?.message || "Unknown error"}`,
      actions: [],
    };
  }
};

module.exports = { processMessage };
