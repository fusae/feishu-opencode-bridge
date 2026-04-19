export interface BridgeEnv {
  port: number;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuBaseUrl: string;
  feishuVerificationToken?: string;
  groupRequireMention: boolean;
  projectsConfigPath: string;
  stateFilePath: string;
}

export interface ProjectConfig {
  key: string;
  name: string;
  baseUrl: string;
  directory?: string;
  username?: string;
  password?: string;
  systemPrompt?: string;
}

export interface ProjectsFile {
  defaultProjectKey?: string;
  projects: ProjectConfig[];
}

export interface StateData {
  bindings: Record<string, string>;
  sessions: Record<string, string>;
  processedEventIds: string[];
}

export interface FeishuEventEnvelope {
  type?: string;
  challenge?: string;
  token?: string;
  schema?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    token?: string;
    create_time?: string;
    tenant_key?: string;
    app_id?: string;
  };
  event?: FeishuMessageEvent;
}

export interface FeishuMessageEvent {
  sender?: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
  };
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{
      key?: string;
      id?: {
        open_id?: string;
        union_id?: string;
        user_id?: string;
      };
      name?: string;
      tenant_key?: string;
    }>;
  };
}
