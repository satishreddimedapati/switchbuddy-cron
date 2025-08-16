import fetch from "node-fetch";

export default async function handler(req, res) {
  const TELEGRAM_BOT_TOKEN = "8081926267:AAGr--3L2kQNxrTghvq5S2C22RgnBFJp22Q";
  const TELEGRAM_CHAT_ID = "821974194"; // Your chat ID

  const dailyDebrief = {
    name: "Satish Reddy",
    summary: "3/5 tasks completed",
    streak: 4,
    missedTasks: ["React Hooks Practice → Tomorrow 8AM", "DBMS Flashcards → Tomorrow 1PM"],
    topPriorities: [
      "Components: Creating, Nesting, and Communicating Between Components",
      "Complete new app",
      "Family Time at 12:00 PM"
    ]
  };

  const message = `
📝 Daily Debrief for ${dailyDebrief.name}

✅ Today’s Summary: ${dailyDebrief.summary}
🔥 Consistency Streak: ${dailyDebrief.streak} days

📌 Missed / Rescheduled Tasks:
${dailyDebrief.missedTasks.join("\n")}

🎯 Top 3 Priorities for Tomorrow:
${dailyDebrief.topPriorities.map((t,i)=>`${i+1}. ${t}`).join("\n")}

💡 Tip from SwitchBuddy: Focus on completing your Top 3 priorities first thing tomorrow.
`;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message })
  });

  res.status(200).json({ status: "success" });
}
