import { ChatCompletionMessageParam } from 'openai/resources';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  tool_call_id?: string;
  name?: string;
}

export type ChatResponse = {
  response: string;
  updatedHistory: Message[];
};

export type KnowledgeDocument = {
  id: string;
  title: string;
  content: string;
  metadata?: Record<string, any>;
};

export type SearchResult = {
  documentId: string;
  title: string;
  excerpt: string;
  relevanceScore: number;
};

export type AvailabilityArgs = {
  startDateTime: string;
  endDateTime: string;
  calendarId?: string;
};

export type AvailabilityResult = {
  isAvailable: boolean;
  busySlots: any[];
  startDateTime: string;
  endDateTime: string;
};

export type AppointmentArgs = {
  summary: string;
  description?: string;
  startDateTime: string;
  endDateTime: string;
  location?: string;
  attendees?: string[];
  calendarId?: string;
};

export type AppointmentResult = {
  success: boolean;
  message?: string;
  eventId?: string;
  htmlLink?: string;
  summary?: string;
  startDateTime?: string;
  endDateTime?: string;
  conflictingEvents?: any[];
};

export type CancelAppointmentArgs = {
  eventId: string;
  calendarId?: string;
};

export type CancelAppointmentResult = {
  success: boolean;
  message: string;
  eventId: string;
};

export type ListAppointmentsArgs = {
  maxResults?: number;
  calendarId?: string;
};

export type AppointmentEvent = {
  id: string;
  summary: string;
  description?: string;
  startDateTime: string;
  endDateTime: string;
  location?: string;
  attendees?: string[];
};

export type ListAppointmentsResult = {
  events: AppointmentEvent[];
  count: number;
};

export type KnowledgeSearchArgs = {
  query: string;
  maxResults?: number;
};

export type KnowledgeSearchResult = {
  results: SearchResult[];
};

export type DocumentContentArgs = {
  documentId: string;
};

export type DocumentContentResult = {
  document?: KnowledgeDocument;
  error?: string;
};

export type SessionStore = {
  [sessionId: string]: Message[];
};

export type VectorStoreEntry = {
  documentId: string;
  embedding: number[];
};

export type PersistedData = {
  knowledgeBase: KnowledgeDocument[];
  vectorStore: VectorStoreEntry[];
  timestamp: string;
};

// Convert our custom Message type to OpenAI's ChatCompletionMessageParam
export function convertToOpenAIMessage(message: Message): ChatCompletionMessageParam {
  if (message.role === 'system') {
    return { role: 'system', content: message.content };
  } else if (message.role === 'user') {
    return { role: 'user', content: message.content };
  } else if (message.role === 'assistant') {
    const assistantMessage: ChatCompletionMessageParam = { 
      role: 'assistant', 
      content: message.content 
    };
    return assistantMessage;
  } else if (message.role === 'tool') {
    if (!message.tool_call_id) {
      throw new Error('Tool messages must have tool_call_id');
    }
    return { 
      role: 'tool', 
      content: message.content, 
      tool_call_id: message.tool_call_id
      // Note: 'name' property has been removed as it's not in the OpenAI type definition
    };
  }
  throw new Error(`Unsupported role: ${message.role}`);
}