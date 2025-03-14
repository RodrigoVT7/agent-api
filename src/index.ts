import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import fs from 'fs/promises';
import path from 'path';
import chokidar from 'chokidar';

import {
  Message,
  ChatResponse,
  KnowledgeDocument,
  SearchResult,
  AvailabilityArgs,
  AvailabilityResult,
  AppointmentArgs,
  AppointmentResult,
  CancelAppointmentArgs,
  CancelAppointmentResult,
  ListAppointmentsArgs,
  ListAppointmentsResult,
  SessionStore,
  PersistedData,
  convertToOpenAIMessage
} from './types';

import {
  calculateCosineSimilarity,
  chunkContent,
  extractRelevantExcerpt,
  generateEmbeddingsForDocuments,
  persistKnowledgeBase,
  basicKeywordSearch
} from './utils';

// Load environment variables
dotenv.config();

// Configure OpenAI with Azure details
const chatOpenAI = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY as string,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.CHAT_DEPLOYMENT_NAME}`,
  defaultQuery: { 'api-version': process.env.AZURE_OPENAI_API_VERSION },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY as string }
});

const embeddingOpenAI = new OpenAI({
  apiKey: process.env.AZURE_EMBEDDINGS_API_KEY as string,
  baseURL: `${process.env.AZURE_EMBEDDINGS_ENDPOINT}/openai/deployments/${process.env.EMBEDDING_DEPLOYMENT_NAME}`,
  defaultQuery: { 'api-version': process.env.AZURE_EMBEDDINGS_API_VERSION },
  defaultHeaders: { 'api-key': process.env.AZURE_EMBEDDINGS_API_KEY as string }
});

// Setup Google Calendar API
const oAuth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

oAuth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });

// Your system prompt
const systemPrompt = `Eres un asistente de programación útil que gestiona reservas y crea citas en Google Calendar.

Propósito: Ayudar a los usuarios a programar citas, hacer reservas y gestionar su calendario.

Directrices:
- Mantener un tono profesional, amigable y eficiente
- Recopilar toda la información necesaria antes de crear citas (fecha, hora, duración, propósito)
- Verificar la disponibilidad del horario antes de confirmar citas
- Proporcionar detalles claros de confirmación después de programar
- Ayudar a los usuarios a reprogramar o cancelar citas cuando sea necesario
- Sugerir horarios alternativos cuando los espacios solicitados no estén disponibles
- Al responder preguntas, utilizar la base de conocimientos para proporcionar información precisa

Conocimientos:
- Puedes verificar la disponibilidad del calendario
- Puedes crear, modificar y cancelar eventos del calendario
- Entiendes las convenciones de programación y zonas horarias
- Tienes acceso a una base de conocimientos con políticas, procedimientos y preguntas frecuentes

Formato de respuesta:
- Sé conciso pero completo
- Para solicitudes de programación, confirma todos los detalles
- Para consultas de calendario, presenta la información claramente
- Siempre confirma las operaciones exitosas del calendario
- Cuando hagas referencia a información de la base de conocimientos, cita el documento fuente

Recuerda verificar todos los detalles de programación y proporcionar números de confirmación para las citas.`;


// Knowledge base setup
const knowledgeBasePath = process.env.KNOWLEDGE_BASE_PATH || './knowledge';
const vectorStorePath = path.join(knowledgeBasePath, 'vector-store.json');
let knowledgeBase: KnowledgeDocument[] = [];
let vectorStore: {documentId: string, embedding: number[]}[] = [];

// Define function specifications
const functions = [
  {
    type: "function" as const,
    function: {
      name: "searchKnowledgeBase",
      description: "Search the knowledge base for relevant information",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query to find relevant information"
          },
          maxResults: {
            type: "number",
            description: "Maximum number of search results to return",
            default: 3
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "getDocumentContent",
      description: "Get the full content of a specific document from the knowledge base",
      parameters: {
        type: "object",
        properties: {
          documentId: {
            type: "string",
            description: "The ID of the document to retrieve"
          }
        },
        required: ["documentId"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "checkAvailability",
      description: "Check if a specific time slot is available on the calendar",
      parameters: {
        type: "object",
        properties: {
          startDateTime: {
            type: "string",
            description: "Start date and time in ISO format (YYYY-MM-DDTHH:MM:SS)"
          },
          endDateTime: {
            type: "string",
            description: "End date and time in ISO format (YYYY-MM-DDTHH:MM:SS)"
          },
          calendarId: {
            type: "string",
            description: "Calendar ID to check (default: primary)",
            default: "primary"
          }
        },
        required: ["startDateTime", "endDateTime"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "createAppointment",
      description: "Create a new appointment on Google Calendar",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Title of the appointment"
          },
          description: {
            type: "string",
            description: "Description or notes for the appointment"
          },
          startDateTime: {
            type: "string",
            description: "Start date and time in ISO format (YYYY-MM-DDTHH:MM:SS)"
          },
          endDateTime: {
            type: "string",
            description: "End date and time in ISO format (YYYY-MM-DDTHH:MM:SS)"
          },
          location: {
            type: "string",
            description: "Location of the appointment"
          },
          attendees: {
            type: "array",
            description: "List of attendee email addresses",
            items: {
              type: "string"
            }
          },
          calendarId: {
            type: "string",
            description: "Calendar ID to create event on (default: primary)",
            default: "primary"
          }
        },
        required: ["summary", "startDateTime", "endDateTime"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "cancelAppointment",
      description: "Cancel an existing appointment on Google Calendar",
      parameters: {
        type: "object",
        properties: {
          eventId: {
            type: "string",
            description: "ID of the event to cancel"
          },
          calendarId: {
            type: "string",
            description: "Calendar ID containing the event (default: primary)",
            default: "primary"
          }
        },
        required: ["eventId"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "listUpcomingAppointments",
      description: "List upcoming appointments on Google Calendar",
      parameters: {
        type: "object",
        properties: {
          maxResults: {
            type: "number",
            description: "Maximum number of events to return",
            default: 10
          },
          calendarId: {
            type: "string",
            description: "Calendar ID to list events from (default: primary)",
            default: "primary"
          }
        }
      }
    }
  }
];

// Calendar API Functions Implementation
async function checkAvailability(args: AvailabilityArgs): Promise<AvailabilityResult> {
  const { startDateTime, endDateTime, calendarId = 'primary' } = args;
  
  try {
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: startDateTime.endsWith('Z') ? startDateTime : `${startDateTime}Z`,
        timeMax: endDateTime.endsWith('Z') ? endDateTime : `${endDateTime}Z`,
        items: [{ id: calendarId }]
      }
    });
    
    const calendars = response.data.calendars || {};
    const calendarData = calendars[calendarId] || { busy: [] };
    const busySlots = calendarData.busy || [];
    const isAvailable = busySlots.length === 0;
    
    return {
      isAvailable,
      busySlots,
      startDateTime,
      endDateTime
    };
  } catch (error: any) {
    console.error("Calendar API Error:", error);
    if (error.response && error.response.data) {
      console.error("Detailed error:", JSON.stringify(error.response.data, null, 2));
    }
    throw new Error("Failed to check availability");
  }
}

async function createAppointment(args: AppointmentArgs): Promise<AppointmentResult> {
  const { 
    summary, 
    description, 
    startDateTime, 
    endDateTime, 
    location, 
    attendees = [], 
    calendarId = 'primary' 
  } = args;
  
  try {
    // First check if the time slot is available
    const availability = await checkAvailability({
      startDateTime,
      endDateTime,
      calendarId
    });
    
    if (!availability.isAvailable) {
      return {
        success: false,
        message: "The requested time slot is not available",
        conflictingEvents: availability.busySlots
      };
    }
    
    // Create the event
    const event = {
      summary,
      description,
      start: {
        dateTime: startDateTime,
        timeZone: 'America/Los_Angeles', // Adjust timezone as needed
      },
      end: {
        dateTime: endDateTime,
        timeZone: 'America/Los_Angeles', // Adjust timezone as needed
      },
      location,
      attendees: attendees.map(email => ({ email })),
      sendUpdates: 'all'
    };
    
    const response = await calendar.events.insert({
      calendarId,
      requestBody: event
    });
    
    return {
      success: true,
      eventId: response.data.id || "",
      htmlLink: response.data.htmlLink || "",
      summary,
      startDateTime,
      endDateTime
    };
  } catch (error) {
    console.error("Calendar API Error:", error);
    throw new Error("Failed to create appointment");
  }
}

async function cancelAppointment(args: CancelAppointmentArgs): Promise<CancelAppointmentResult> {
  const { eventId, calendarId = 'primary' } = args;
  
  try {
    await calendar.events.delete({
      calendarId,
      eventId
    });
    
    return {
      success: true,
      message: "Appointment successfully cancelled",
      eventId
    };
  } catch (error) {
    console.error("Calendar API Error:", error);
    throw new Error("Failed to cancel appointment");
  }
}

async function listUpcomingAppointments(args: ListAppointmentsArgs): Promise<ListAppointmentsResult> {
  const { maxResults = 10, calendarId = 'primary' } = args;
  
  try {
    const response = await calendar.events.list({
      calendarId,
      timeMin: (new Date()).toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: 'startTime'
    });
    
    const items = response.data.items || [];
    const events = items.map(event => {
      const startData = event.start || {};
      const endData = event.end || {};
      return {
        id: event.id || "",
        summary: event.summary || "",
        description: event.description || undefined,
        startDateTime: startData.dateTime || startData.date || "",
        endDateTime: endData.dateTime || endData.date || "",
        location: event.location || undefined,
        attendees: event.attendees?.map(a => a.email || "") || []
      };
    });
    
    return {
      events,
      count: events.length
    };
  } catch (error) {
    console.error("Calendar API Error:", error);
    throw new Error("Failed to list appointments");
  }
}

// Knowledge Base Functions
async function searchKB(args: { query: string, maxResults?: number }): Promise<{ results: SearchResult[] }> {
  const { query, maxResults = 3 } = args;
  
  try {
    // Try semantic search first
    const results = await semanticSearch(query, maxResults);
    return { results };
  } catch (error) {
    console.error('Semantic search failed, falling back to keyword search:', error);
    // Fall back to keyword search
    const results = basicKeywordSearch(query, knowledgeBase, maxResults);
    return { results };
  }
}

async function semanticSearch(query: string, maxResults: number = 3): Promise<SearchResult[]> {
  try {
    // Generate embedding for the query
    const queryEmbeddingResponse = await embeddingOpenAI.embeddings.create({
      model: "text-embedding-ada-002",
      input: query
    });
    
    const queryEmbedding = queryEmbeddingResponse.data[0].embedding;
    
    // Calculate similarity with all documents
    const scoredResults = vectorStore.map(entry => {
      const doc = knowledgeBase.find(d => d.id === entry.documentId);
      if (!doc) return null;
      
      const similarity = calculateCosineSimilarity(queryEmbedding, entry.embedding);
      
      return {
        documentId: entry.documentId,
        title: doc.title,
        excerpt: extractRelevantExcerpt(doc.content, query),
        relevanceScore: similarity * 100 // Convert to percentage
      };
    }).filter(result => result !== null) as SearchResult[];
    
    // Sort by relevance and return top results
    return scoredResults
      .filter(result => result.relevanceScore > 20) // Only return relevant results
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, maxResults);
  } catch (error) {
    throw error;
  }
}

async function getDocument(args: { documentId: string }): Promise<{ document?: KnowledgeDocument, error?: string }> {
  const { documentId } = args;
  const document = knowledgeBase.find(doc => doc.id === documentId);
  
  if (!document) {
    return { error: `Document with ID ${documentId} not found` };
  }
  
  return { document };
}

// Function dispatcher
async function callFunction(functionName: string, args: any): Promise<any> {
  switch (functionName) {
    case "searchKnowledgeBase":
      return await searchKB(args);
    case "getDocumentContent":
      return await getDocument(args);
    case "checkAvailability":
      return await checkAvailability(args as AvailabilityArgs);
    case "createAppointment":
      return await createAppointment(args as AppointmentArgs);
    case "cancelAppointment":
      return await cancelAppointment(args as CancelAppointmentArgs);
    case "listUpcomingAppointments":
      return await listUpcomingAppointments(args as ListAppointmentsArgs);
    default:
      throw new Error(`Function ${functionName} not implemented`);
  }
}

// Load the knowledge base from directory
async function loadKnowledgeBase(directoryPath: string): Promise<void> {
  try {
    // First check if we have a persisted vector store
    let hasPersistedVectors = false;
    try {
      const vectorStoreContent = await fs.readFile(vectorStorePath, 'utf8');
      const persistedData = JSON.parse(vectorStoreContent) as PersistedData;
      
      if (persistedData.vectorStore && persistedData.knowledgeBase) {
        vectorStore = persistedData.vectorStore;
        knowledgeBase = persistedData.knowledgeBase;
        console.log(`Loaded ${knowledgeBase.length} documents and ${vectorStore.length} vectors from cache`);
        hasPersistedVectors = true;
      }
    } catch (error) {
      console.log("No persisted vector store found, will generate embeddings from scratch");
    }
    
    // If we couldn't restore from cache, load from files
    if (!hasPersistedVectors) {
      // Clear existing data
      knowledgeBase = [];
      vectorStore = [];
      
      // Get all files in the directory
      const files = await fs.readdir(directoryPath);
      
      // Process only content files (skip our vector store)
      const contentFiles = files.filter(file => 
        (file.endsWith('.md') || file.endsWith('.txt') || file.endsWith('.json')) &&
        file !== 'vector-store.json'
      );
      
      // Process each file
      for (const file of contentFiles) {
        const filePath = path.join(directoryPath, file);
        const content = await fs.readFile(filePath, 'utf8');
        
        const document: KnowledgeDocument = {
          id: file,
          title: file.replace(/\.(md|txt|json)$/, ''),
          content: content,
          metadata: {}
        };
        
        // Add metadata if it's a JSON file
        if (file.endsWith('.json')) {
          try {
            const jsonContent = JSON.parse(content);
            document.content = jsonContent.content || content;
            document.metadata = jsonContent.metadata || {};
            document.title = jsonContent.title || document.title;
          } catch (e) {
            console.warn(`Failed to parse JSON for ${file}:`, e);
          }
        }
        
        // Preprocess content - chunk into manageable sections if too large
        if (document.content.length > 10000) {
          // Create chunks
          const chunks = chunkContent(document.content);
          
          // Add each chunk as a separate document
          chunks.forEach((chunk, index) => {
            const chunkDoc: KnowledgeDocument = {
              id: `${document.id}-chunk-${index}`,
              title: `${document.title} - Part ${index + 1}`,
              content: chunk,
              metadata: { ...document.metadata, parentId: document.id, chunkIndex: index }
            };
            
            knowledgeBase.push(chunkDoc);
          });
        } else {
          knowledgeBase.push(document);
        }
      }
      
      console.log(`Loaded ${knowledgeBase.length} documents into knowledge base`);
      
      // Generate embeddings for all documents
      knowledgeBase = await generateEmbeddingsForDocuments(embeddingOpenAI, knowledgeBase);
      
      // Create vector store
      vectorStore = knowledgeBase
        .filter(doc => doc.metadata?.embedding)
        .map(doc => ({
          documentId: doc.id,
          embedding: doc.metadata?.embedding
        }));
      
      // Persist to disk
      await persistKnowledgeBase(knowledgeBasePath, knowledgeBase, vectorStore);
    }
  } catch (error) {
    console.error('Error loading knowledge base:', error);
  }
}

// Enhanced chat with the bot - automatically uses semantic search
async function chatWithBot(userMessage: string, conversationHistory: Message[] = []): Promise<ChatResponse> {
  try {
    // Get recent context from conversation history (last 10 messages)
    const recentMessages = conversationHistory.slice(-10);
    
    // Before sending to the model, try to proactively search knowledge base for relevant info
    // based on the user's question
    let relevantInfo = "";
    
    // Check if this looks like a question or informational request
    if (userMessage.includes("?") || 
        /what|how|when|where|why|can|do|is|are|policy|policies|appointment|schedule/i.test(userMessage)) {
      
      try {
        // Search knowledge base for relevant information
        const searchResults = await semanticSearch(userMessage, 3);
        
        if (searchResults.length > 0) {
          // Add relevant documents to context
          relevantInfo = "Based on our knowledge base, here is some relevant information:\n\n";
          
          for (const result of searchResults) {
            const doc = knowledgeBase.find(d => d.id === result.documentId);
            if (doc) {
              // If it's a chunk, get the full document
              if (doc.metadata?.parentId) {
                const parentDoc = knowledgeBase.find(d => d.id === doc.metadata?.parentId);
                if (parentDoc) {
                  relevantInfo += `From "${parentDoc.title}":\n${doc.content}\n\n`;
                } else {
                  relevantInfo += `From "${doc.title}":\n${doc.content}\n\n`;
                }
              } else {
                relevantInfo += `From "${doc.title}":\n${doc.content}\n\n`;
              }
            }
          }
        }
      } catch (error) {
        console.error('Error searching knowledge base:', error);
      }
    }
    
    // Create enhanced system prompt with relevant knowledge if found
    let enhancedSystemPrompt = systemPrompt;
    if (relevantInfo) {
      enhancedSystemPrompt += `\n\nRELEVANT KNOWLEDGE:\n${relevantInfo}`;
    }
    
    // Create messages array for the model
    const messages = [
      { role: 'system' as const, content: enhancedSystemPrompt },
      ...recentMessages,
      { role: 'user' as const, content: userMessage }
    ];
    
    // First, ask the model if it wants to call a function
    const openAIMessages = messages.map(convertToOpenAIMessage);
    const response = await chatOpenAI.chat.completions.create({
      model: process.env.CHAT_DEPLOYMENT_NAME as string, // Updated model name variable
      messages: openAIMessages,
      temperature: 0.7,
      tools: functions,
      tool_choice: "auto"
    });
    
    const responseMessage = response.choices[0].message;
    
    // Add model's response to conversation history
    const responseMessageForHistory: Message = {
      role: 'assistant',
      content: responseMessage.content || ""
    };
    messages.push(responseMessageForHistory);
    
    // Check if the model wanted to call a function
    if (responseMessage.tool_calls) {
      const toolCalls = responseMessage.tool_calls;
      
        // Add the assistant's message with tool_calls to the conversation
      messages.push({
        role: 'assistant',
        content: responseMessage.content || "",
        tool_calls: responseMessage.tool_calls
      });

      for (const toolCall of toolCalls) {
        // Execute the function
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);
        
        console.log(`Calling function: ${functionName}`, functionArgs);
        
        try {
            const functionResponse = await callFunction(functionName, functionArgs);
            
            // Add the function response to the messages
            messages.push({
              role: "tool" as const,
              tool_call_id: toolCall.id,
              content: JSON.stringify(functionResponse)
              // Note: 'name' property is removed because it's not in the OpenAI type definition
            });
          } catch (error) {
            messages.push({
              role: "tool" as const,
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: (error as Error).message })
              // Note: 'name' property is removed
            });
          }
      }
      
      // Get a new response from the model after function call
      const secondResponse = await chatOpenAI.chat.completions.create({
        model: process.env.CHAT_DEPLOYMENT_NAME as string, // Updated model name variable
        messages: messages.map(convertToOpenAIMessage),
        temperature: 0.7
      });
      
      const secondResponseMessage = secondResponse.choices[0].message;
      
      // Create complete history by adding user message and new response
      const completeHistory = [
        ...conversationHistory, 
        { role: 'user' as const, content: userMessage },
        { role: 'assistant' as const, content: secondResponseMessage.content || "" }
      ];
      
      return {
        response: secondResponseMessage.content || "",
        updatedHistory: completeHistory
      };
    }
    
    // Create complete history with user message and response
    const completeHistory = [
      ...conversationHistory,
      { role: 'user' as const, content: userMessage },
      { role: 'assistant' as const, content: responseMessage.content || "" }
    ];
    
    return {
      response: responseMessage.content || "",
      updatedHistory: completeHistory
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      response: 'Sorry, I encountered an error processing your request.',
      updatedHistory: conversationHistory
    };
  }
}

// Create a web server to interact with the bot
const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// Store conversation history (in memory for demo purposes)
// In production, use a database
const sessions: SessionStore = {};

app.use(bodyParser.json());
app.use(express.static('public'));

interface ChatRequest {
  message: string;
  sessionId: string;
}

app.post('/api/chat', async (req: Request, res: Response) => {
  const { message, sessionId } = req.body as ChatRequest;
  const sessionHistory = sessions[sessionId] || [];
  
  const { response, updatedHistory } = await chatWithBot(message, sessionHistory);
  
  // Update session history
  sessions[sessionId] = updatedHistory;
  
  res.json({ response });
});

app.get('/api/list-kb', (req: Request, res: Response) => {
  const documentsInfo = knowledgeBase.map(doc => ({
    id: doc.id,
    title: doc.title,
    contentPreview: doc.content.substring(0, 100) + '...',
    hasEmbedding: !!doc.metadata?.embedding
  }));
  res.json(documentsInfo);
});

app.get('/api/list-calendars', async (req, res) => {
  try {
    const response = await calendar.calendarList.list();
    res.json(response.data);
  } catch (error) {
    console.error("Error listing calendars:", error);
    res.status(500).json({ error: "Failed to list calendars" });
  }
});

// Initialize and start the server
async function startServer() {
  try {
    // Ensure the knowledge base directory exists
    try {
      await fs.access(knowledgeBasePath);
    } catch (error) {
      console.log(`Knowledge base directory does not exist. Creating ${knowledgeBasePath}`);
      await fs.mkdir(knowledgeBasePath, { recursive: true });
      
      // Create sample documents
      const sampleDocs = [
        {
          title: "Appointment Policies",
          content: "# Appointment Policies\n\n" +
                  "## Cancellation Policy\n" +
                  "Appointments must be cancelled at least 24 hours in advance to avoid a cancellation fee.\n\n" +
                  "## Late Arrival Policy\n" +
                  "If you arrive more than 15 minutes late, we may need to reschedule your appointment.\n\n" +
                  "## Rescheduling\n" +
                  "Appointments can be rescheduled up to 2 times without penalty.",
          metadata: {
            category: "policies",
            importance: "high"
          }
        },
        {
          title: "Virtual Appointment Guide",
          content: "# Preparing for Your Virtual Appointment\n\n" +
                  "## Technical Requirements\n" +
                  "- A device with a camera and microphone (smartphone, tablet, or computer)\n" +
                  "- Stable internet connection\n" +
                  "- Our secure meeting application (download link provided in confirmation email)\n\n" +
                  "## Before Your Appointment\n" +
                  "1. Test your device and internet connection\n" +
                  "2. Find a quiet, private space\n" +
                  "3. Have any relevant documents ready\n" +
                  "4. Log in 5 minutes early to test your connection",
          metadata: {
            category: "guides",
            importance: "medium"
          }
        },
        {
          title: "Frequently Asked Questions",
          content: "# Frequently Asked Questions\n\n" +
                  "## How do I reschedule my appointment?\n" +
                  "You can reschedule your appointment by calling our office or using the online portal at least 24 hours before your scheduled time.\n\n" +
                  "## What happens if I miss my appointment?\n" +
                  "Missed appointments without prior notice may incur a fee and will require rescheduling.\n\n" +
                  "## Can I request a specific consultant?\n" +
                  "Yes, you can request a specific consultant when booking your appointment, subject to their availability.",
          metadata: {
            category: "faq",
            importance: "high"
          }
        }
      ];
      
      // Write sample documents to files
      for (const doc of sampleDocs) {
        const filename = doc.title.toLowerCase().replace(/\s+/g, '-') + '.json';
        await fs.writeFile(
          path.join(knowledgeBasePath, filename),
          JSON.stringify(doc, null, 2),
          'utf8'
        );
      }
    }
    
    // Load the knowledge base (with cached vectors if available)
    await loadKnowledgeBase(knowledgeBasePath);
    
    // File watcher for knowledge base updates
    const watcher = chokidar.watch(knowledgeBasePath, {
      ignored: /vector-store\.json$/,
      persistent: true
    });
    
    // When files change, update the knowledge base
    watcher.on('all', async (event, path) => {
      if (event === 'add' || event === 'change' || event === 'unlink') {
        console.log(`Knowledge base changed: ${event} ${path}`);
        // Only reload if it's not our vector store file
        if (!path.endsWith('vector-store.json')) {
          await loadKnowledgeBase(knowledgeBasePath);
        }
      }
    });
    
    // Start the server
    app.listen(port, () => {
      console.log(`Bot server running at http://localhost:${port}`);
      console.log(`Knowledge base loaded with ${knowledgeBase.length} documents`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();