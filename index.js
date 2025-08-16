import 'dotenv/config';
import cron from 'node-cron';
import admin from 'firebase-admin';
import { genkit, z } from 'genkit';
import { googleAI } from '@genkit-ai/googleai';
import { definePrompt, defineFlow } from 'genkit';

// Initialize Genkit and Google AI plugin
genkit({
  plugins: [googleAI()],
});

// Initialize Firebase Admin SDK
// Your service account key will be loaded from environment variables you set in Railway.
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
console.log("Firebase Admin Initialized.");

// Define the Genkit schemas and flows directly in this service
// This makes the cron service self-contained

// Schemas from the main app's types.ts
const DailyTaskSchema = z.object({
  id: z.string(),
  time: z.string(),
  title: z.string(),
  description: z.string().optional(),
  type: z.enum(['schedule', 'interview']),
  date: z.string(),
  completed: z.boolean(),
  userId: z.string(),
});

const GenerateDailySummaryInputSchema = z.object({
  tasks: z.array(DailyTaskSchema).describe("A list of today's tasks, including their completion status."),
});

const MissedTaskSchema = z.object({
  title: z.string().describe("The title of the missed task."),
  rescheduledTime: z.string().describe("The suggested rescheduled time for tomorrow, e.g., 'Tomorrow 8AM'."),
});

const GenerateDailySummaryOutputSchema = z.object({
  motivationalSummary: z.string().describe("A short, encouraging summary of the day's achievements."),
  nextDayPriorities: z.array(z.string()).describe('The top 3 recommended priority tasks for tomorrow.'),
  completedTasks: z.number().describe('The number of tasks completed today.'),
  totalTasks: z.number().describe('The total number of tasks for today.'),
  streak: z.number().describe('The current number of consecutive days with at least one completed task.'),
  missedTasks: z.array(MissedTaskSchema).describe("A list of incomplete tasks from today, with a suggested rescheduled time for tomorrow."),
});

const SendDailyDebriefOutputSchema = z.object({
    success: z.boolean(),
    message: z.string(),
});

// Genkit flow to generate summary
const generateSummaryPrompt = definePrompt({
  name: 'generateDailySummaryCronPrompt',
  inputSchema: GenerateDailySummaryInputSchema,
  outputSchema: GenerateDailySummaryOutputSchema,
  prompt: `You are an encouraging and insightful productivity coach. Your goal is to help the user reflect on their day and prepare for the next one.
You will be given a list of tasks and their completion status for today.
Your tasks are to:
1.  **motivationalSummary**: Write a short, motivational summary of the user's accomplishments. Focus on what they completed.
2.  **nextDayPriorities**: Based on the incomplete tasks and general productivity principles, identify and suggest the top 3 most important priorities for tomorrow.
3.  **completedTasks**: Count the number of completed tasks.
4.  **totalTasks**: Count the total number of tasks.
5.  **streak**: Return a fictional but realistic streak number between 2 and 10.
6.  **missedTasks**: For each incomplete task, create an object with its title and a suggested rescheduled time for tomorrow (e.g., "Tomorrow 8AM", "Tomorrow 1PM").

Today's Tasks:
{{#each tasks}}
- {{this.title}} (Completed: {{this.completed}})
{{/each}}
`,
});

const generateDailySummaryFlow = defineFlow(
  {
    name: 'generateDailySummaryCronFlow',
    inputSchema: GenerateDailySummaryInputSchema,
    outputSchema: GenerateDailySummaryOutputSchema,
  },
  async (input) => {
    const { output } = await generateSummaryPrompt(input);
    return output;
  }
);

// Genkit flow to send telegram message
const sendDailyDebriefFlow = defineFlow(
    {
        name: 'sendDailyDebriefCronFlow',
        inputSchema: GenerateDailySummaryOutputSchema,
        outputSchema: SendDailyDebriefOutputSchema,
    },
    async (summary) => {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;

        if (!botToken || !chatId) {
            throw new Error("Telegram credentials are not configured in environment variables.");
        }

        let messageText = \`📝 Daily Debrief\n\`;
        messageText += \`✅ Today’s Summary: \${summary.completedTasks}/\${summary.totalTasks} tasks completed\n\`;
        messageText += \`🔥 Streak: \${summary.streak} days\n\`;

        if (summary.missedTasks.length > 0) {
            messageText += \`📌 Missed Tasks:\n\`;
            summary.missedTasks.forEach(task => {
                messageText += \`- \${task.title} → \${task.rescheduledTime}\n\`;
            });
        }

        if (summary.nextDayPriorities.length > 0) {
            messageText += \`🎯 Top 3 Priorities for Tomorrow:\n\`;
            summary.nextDayPriorities.forEach((priority, index) => {
                messageText += \`\${index + 1}. \${priority}\n\`;
            });
        }
        
        const url = \`https://api.telegram.org/bot\${botToken}/sendMessage\`;
        
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: messageText }),
            });
            const result = await response.json();
            if (!result.ok) {
                console.error('Telegram API Error:', result.description);
                return { success: false, message: \`Telegram API Error: \${result.description}\` };
            }
            return { success: true, message: 'Message sent successfully.' };
        } catch (error) {
            console.error("Failed to send Telegram message:", error);
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            return { success: false, message: \`Failed to send message: \${errorMessage}\` };
        }
    }
);


// The main function that runs for the cron job
async function runDailyDebrief() {
    console.log('Starting daily debrief job...');
    const todayStr = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD format
    
    try {
        const usersSnapshot = await db.collection('users').get();
        if (usersSnapshot.empty) {
            console.log("No users found to process.");
            return;
        }

        for (const userDoc of usersSnapshot.docs) {
            const userId = userDoc.id;
            console.log(\`Processing user: \${userId}\`);

            const tasksSnapshot = await db.collection('daily_tasks')
                .where('userId', '==', userId)
                .where('date', '==', todayStr)
                .get();

            if (tasksSnapshot.empty) {
                console.log(\`No tasks for user \${userId} today. Skipping.\`);
                continue;
            }

            const tasks = tasksSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            console.log(\`Found \${tasks.length} tasks. Generating summary...\`);
            const summary = await generateDailySummaryFlow({ tasks });
            
            if (summary) {
                console.log(\`Summary generated. Sending to Telegram...\`);
                await sendDailyDebriefFlow(summary);
                console.log(\`Debrief sent successfully for user \${userId}.\`);
            } else {
                 console.log(\`Could not generate summary for user \${userId}.\`);
            }
        }
    } catch (error) {
        console.error('Error during daily debrief job:', error);
    }
    console.log('Daily debrief job finished.');
}


// Schedule the job to run at 14:50 every day.
// You can change this schedule string.
cron.schedule('50 14 * * *', () => {
  console.log('Cron job triggered at 14:50.');
  runDailyDebrief();
}, {
  scheduled: true,
  timezone: "Asia/Kolkata" // Example: Set to your timezone
});

console.log("Cron job scheduled. Waiting for the trigger time...");
