export interface BridgeEnv {
  feishuAppId: string;
  feishuAppSecret: string;
  feishuDomain: "Feishu" | "Lark";
  feishuVerificationToken?: string;
  feishuEncryptKey?: string;
  projectsRoot: string;
  stateFilePath: string;
  groupRequireMention: boolean;
  pageSize: number;
  opencodeServerHostname: string;
  opencodeServerPort: number;
  opencodeServerPassword?: string;
  opencodeServerUsername: string;
  opencodeSystemPrompt?: string;
}

export interface ChatBinding {
  directory: string;
  sessionId?: string;
}

export interface PendingSelector {
  page: number;
  query: string;
  pendingPrompt?: string;
}

export interface PendingQuestion {
  sessionId: string;
  questions: string[];
}

export interface StateData {
  bindings: Record<string, ChatBinding>;
  pendingSelectors: Record<string, PendingSelector>;
  pendingQuestions: Record<string, PendingQuestion>;
  processedMessageIds: string[];
  processedActionTokens: string[];
}

export interface DirectoryOption {
  name: string;
  path: string;
}

export interface CardActionValue {
  action: "select_project" | "selector_prev" | "selector_next" | "selector_refresh";
  chatId: string;
  path?: string;
}
