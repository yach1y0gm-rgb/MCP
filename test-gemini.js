import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    console.error("GEMINI_API_KEY is not set.");
    process.exit(1);
}

const ai = new GoogleGenAI({
    apiKey
});

try {
    const response = await ai.models.generateContent({
        model: "gemini-3.6-flash",
        contents: "これはAPI接続テストです。「Gemini API接続成功」とだけ返してください。"
    });

    console.log("Gemini API response:");
    console.log(response.text);
} catch (error) {
    console.error("Gemini API request failed:");
    console.error(error);
    process.exit(1);
}