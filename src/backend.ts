export type PromptInput = {
  text: string;
  imagePaths?: string[];
};

export type PromptResult =
  | {
      type: "reply";
      text: string;
    }
  | {
      type: "question";
      questions: string[];
    };

export interface SessionInfo {
  id: string;
  directory?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface BackendPromptResponse {
  sessionId: string;
  result: PromptResult;
}

export interface AgentBackend {
  readonly name: string;
  start(): Promise<void>;
  close(): void;
  createSession(directory: string, title: string): Promise<string>;
  listSessions(directory: string): Promise<SessionInfo[]>;
  deleteSession(directory: string, sessionId: string): Promise<void>;
  prompt(directory: string, sessionId: string | undefined, input: PromptInput): Promise<BackendPromptResponse>;
  isSessionNotFoundError(error: unknown): boolean;
}
