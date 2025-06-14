// Agent Manager for Deno App Engine
// This file manages AI agent instances with optional kernel integration

import { EventEmitter } from "node:events";
import { ensureDir, exists } from "https://deno.land/std@0.208.0/fs/mod.ts";
import { join } from "https://deno.land/std@0.208.0/path/mod.ts";
import { 
  type ChatMessage,
  type ModelSettings,
  DefaultModelSettings
} from "./chatCompletion.ts";
import { 
  Agent, 
  AgentEvents, 
  KernelType, 
  type IAgentConfig, 
  type IAgentInstance 
} from "./agent.ts";
import { KernelLanguage } from "../kernel/manager.ts";

// Model registry events (additional to AgentEvents)
export enum ModelEvents {
  MODEL_ADDED = "model_added",
  MODEL_REMOVED = "model_removed",
  MODEL_UPDATED = "model_updated"
}

// All events (combining AgentEvents and ModelEvents)
export { AgentEvents, KernelType, type IAgentConfig, type IAgentInstance };

// Interface for model registry entry
export interface IModelRegistryEntry {
  id: string;
  modelSettings: ModelSettings;
  created: Date;
  lastUsed?: Date;
}

// Interface for model registry configuration
export interface IModelRegistryConfig {
  [modelId: string]: ModelSettings;
}

// Interface for agent manager options
export interface IAgentManagerOptions {
  maxAgents?: number;
  maxAgentsPerNamespace?: number; // Maximum agents per namespace/workspace
  defaultModelSettings?: ModelSettings;
  defaultModelId?: string; // Name of default model from registry
  defaultMaxSteps?: number;
  maxStepsCap?: number; // Maximum cap for individual completion steps within agents
  agentDataDirectory?: string;
  autoSaveConversations?: boolean;
  defaultKernelType?: KernelType;
  modelRegistry?: IModelRegistryConfig; // Initial model registry configuration
  allowedModels?: string[]; // Array of allowed model IDs from registry
  allowCustomModels?: boolean; // Whether to allow custom model settings
}

// Interface for conversation save data
interface IConversationData {
  agentId: string;
  messages: ChatMessage[];
  savedAt: Date;
  metadata?: Record<string, any>;
}

/**
 * AgentManager class manages multiple AI agent instances
 */
export class AgentManager extends EventEmitter {
  private agents: Map<string, IAgentInstance> = new Map();
  private maxAgents: number;
  private maxAgentsPerNamespace: number;
  private defaultModelSettings: ModelSettings;
  private defaultModelId?: string;
  private defaultMaxSteps: number;
  private maxStepsCap: number;
  private agentDataDirectory: string;
  private autoSaveConversations: boolean;
  private defaultKernelType?: KernelType;
  private kernelManager_: any; // Will be set via setKernelManager
  
  // Model registry
  private modelRegistry: Map<string, IModelRegistryEntry> = new Map();
  private allowedModels?: string[];
  private allowCustomModels: boolean;

  constructor(options: IAgentManagerOptions = {}) {
    super();
    super.setMaxListeners(100);
    
    this.maxAgents = options.maxAgents || 50;
    this.maxAgentsPerNamespace = options.maxAgentsPerNamespace || 10;
    this.defaultModelSettings = options.defaultModelSettings || { ...DefaultModelSettings };
    this.defaultModelId = options.defaultModelId;
    this.defaultMaxSteps = options.defaultMaxSteps || 10;
    this.maxStepsCap = options.maxStepsCap || 10;
    this.agentDataDirectory = options.agentDataDirectory || "./agent_data";
    this.autoSaveConversations = options.autoSaveConversations || false;
    this.defaultKernelType = options.defaultKernelType;
    this.allowedModels = options.allowedModels;
    this.allowCustomModels = options.allowCustomModels !== false; // Default true

    // Initialize model registry from config
    this.initializeModelRegistry(options.modelRegistry);
  }

  /**
   * Initialize the model registry from configuration
   * @param config Model registry configuration
   * @private
   */
  private initializeModelRegistry(config?: IModelRegistryConfig): void {
    if (!config) {
      return;
    }
    
    const now = new Date();
    
    for (const [modelId, modelSettings] of Object.entries(config)) {
      const entry: IModelRegistryEntry = {
        id: modelId,
        modelSettings,
        created: now
      };
      
      this.modelRegistry.set(modelId, entry);
      
      console.log(`📝 Initialized model: ${modelId} (${modelSettings.model})`);
      
      // Emit model added event
      this.emit(ModelEvents.MODEL_ADDED, {
        modelId,
        data: { 
          id: modelId, 
          model: modelSettings.model,
          baseURL: modelSettings.baseURL,
          temperature: modelSettings.temperature,
          created: now
        }
      });
    }
    
    if (Object.keys(config).length > 0) {
      console.log(`✅ Initialized ${Object.keys(config).length} model(s) from configuration`);
    }
  }

  /**
   * Resolve model settings from registry or use provided settings
   * @param modelId Optional model ID from registry
   * @param modelSettings Optional direct model settings
   * @returns Resolved model settings
   * @private
   */
  private resolveModelSettings(modelId?: string, modelSettings?: ModelSettings): ModelSettings {
    // Priority: specific settings > model ID from registry > default model ID > default settings
    if (modelSettings) {
      if (!this.allowCustomModels) {
        throw new Error("Custom model settings are not allowed. Use a model ID from the registry.");
      }
      return { ...modelSettings };
    }
    
    // Try to get from registry using provided model ID
    if (modelId) {
      const registryEntry = this.modelRegistry.get(modelId);
      if (registryEntry) {
        // Check if model is allowed
        if (this.allowedModels && !this.allowedModels.includes(modelId)) {
          throw new Error(`Model ${modelId} is not in the allowed models list`);
        }
        // Update last used time
        registryEntry.lastUsed = new Date();
        return { ...registryEntry.modelSettings };
      } else {
        throw new Error(`Model ${modelId} not found in registry`);
      }
    }
    
    // Try to use default model ID from registry
    if (this.defaultModelId) {
      const registryEntry = this.modelRegistry.get(this.defaultModelId);
      if (registryEntry) {
        registryEntry.lastUsed = new Date();
        return { ...registryEntry.modelSettings };
      } else {
        throw new Error(`Default model ${this.defaultModelId} not found in registry`);
      }
    }
    
    // Fall back to default model settings
    return { ...this.defaultModelSettings };
  }

  // Getter for kernelManager to allow agent access for event listening
  get kernelManager() {
    return this.kernelManager_;
  }

  // Set kernel manager for kernel integration
  setKernelManager(kernelManager: any): void {
    this.kernelManager_ = kernelManager;
  }

  // Getter for maxStepsCap to allow agent access
  getMaxStepsCap(): number {
    return this.maxStepsCap;
  }

  // Helper method to count agents in a specific namespace
  private getAgentCountInNamespace(namespace: string): number {
    let count = 0;
    for (const id of this.agents.keys()) {
      if (id.startsWith(`${namespace}:`)) {
        count++;
      }
    }
    return count;
  }

  // Create a new agent
  async createAgent(config: IAgentConfig): Promise<string> {
    // Validate input
    if (!config.id || !config.name) {
      throw new Error("Agent ID and name are required");
    }

    // make sure the config.id does not contain colons because it will be used as a namespace prefix
    if (config.id.includes(':')) {
      throw new Error('Agent ID cannot contain colons');
    }

    const baseId = config.id;
    // Apply namespace prefix if provided
    const id = config.namespace ? `${config.namespace}:${baseId}` : baseId;

    if (this.agents.has(id)) {
      throw new Error(`Agent with ID "${id}" already exists`);
    }

    if (this.agents.size >= this.maxAgents) {
      throw new Error(`Maximum number of agents (${this.maxAgents}) reached`);
    }

    // Check per-namespace limit if namespace is provided
    if (config.namespace) {
      const namespaceAgentCount = this.getAgentCountInNamespace(config.namespace);
      if (namespaceAgentCount >= this.maxAgentsPerNamespace) {
        throw new Error(`Maximum number of agents per namespace (${this.maxAgentsPerNamespace}) reached for namespace "${config.namespace}"`);
      }
    }

    // Resolve model settings
    const resolvedModelSettings = this.resolveModelSettings(config.modelId, config.ModelSettings);

    // Create agent with defaults
    const agentConfig: IAgentConfig = {
      ...config,
      id: id, // Use full namespaced ID for agent config so agent.id matches the map key
      ModelSettings: resolvedModelSettings,
      maxSteps: config.maxSteps || this.defaultMaxSteps,
      kernelType: config.kernelType || this.defaultKernelType
    };

    const agent = new Agent(agentConfig, this);
    this.agents.set(id, agent);

    this.emit(AgentEvents.AGENT_CREATED, {
      agentId: id,
      config: agentConfig
    });

    console.log(`✅ Created agent: ${id} (${config.name}) with kernelType: ${config.kernelType}`);

    // Auto-attach kernel if requested and conditions are met
    if (config.autoAttachKernel && config.kernelType && this.kernelManager_) {
      try {
        console.log(`🔧 Auto-attaching ${config.kernelType} kernel to agent: ${id}`);
        await this.attachKernelToAgent(id, config.kernelType);
        console.log(`✅ Successfully auto-attached kernel to agent: ${id}`);
      } catch (error) {
        console.error(`❌ Failed to auto-attach kernel to agent ${id}:`, error);
        
        // If it's a startup script error, remove the agent and throw the error to fail creation
        if (error instanceof Error && error.name === 'AgentStartupError') {
          this.agents.delete(id); // Clean up the created agent
          this.emit(AgentEvents.AGENT_ERROR, {
            agentId: id,
            error: error
          });
          throw error; // Propagate startup script errors to fail agent creation
        }
        
        // For other kernel attachment errors, emit event but don't fail agent creation
        this.emit(AgentEvents.AGENT_ERROR, {
          agentId: id,
          error: new Error(`Failed to auto-attach kernel: ${error instanceof Error ? error.message : String(error)}`)
        });
      }
    } else if (config.autoAttachKernel && !this.kernelManager_) {
      console.warn(`⚠️ Auto-attach kernel requested for agent ${id} but no kernel manager is set`);
    }

    return id;
  }

  // Get an agent by ID
  getAgent(id: string): IAgentInstance | undefined {
    return this.agents.get(id);
  }

  // Get list of agent IDs
  getAgentIds(): string[] {
    return Array.from(this.agents.keys());
  }

  // Check if an agent exists
  agentExists(id: string): boolean {
    return this.agents.has(id);
  }

  // List all agents with their info
  listAgents(namespace?: string): Array<{
    id: string;
    name: string;
    description?: string;
    kernel_type?: KernelType;
    hasKernel: boolean;
    hasStartupScript: boolean;
    hasStartupError: boolean;
    created: Date;
    lastUsed?: Date;
    conversationLength: number;
    namespace?: string;
  }> {
    return Array.from(this.agents.entries())
      .filter(([id]) => {
        if (!namespace) return true;
        return id.startsWith(`${namespace}:`);
      })
      .map(([id, agent]) => {
        // Extract namespace from id if present
        const namespaceMatch = id.match(/^([^:]+):/);
        const extractedNamespace = namespaceMatch ? namespaceMatch[1] : undefined;
        
        // Extract base ID without namespace prefix
        const baseId = extractedNamespace ? id.substring(extractedNamespace.length + 1) : id;
        
        return {
          id: baseId, // Return base ID without namespace prefix
          name: agent.name,
          description: agent.description,
          kernel_type: agent.kernelType,
          hasKernel: !!agent.kernel,
          hasStartupScript: !!agent.startupScript,
          hasStartupError: !!agent.getStartupError(),
          created: agent.created,
          lastUsed: agent.lastUsed,
          conversationLength: agent.conversationHistory.length,
          namespace: extractedNamespace
        };
      });
  }

  // Update an agent's configuration
  async updateAgent(id: string, config: Partial<IAgentConfig>): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Agent with ID "${id}" not found`);
    }

    // If updating model settings, resolve them
    if (config.modelId || config.ModelSettings) {
      const resolvedModelSettings = this.resolveModelSettings(config.modelId, config.ModelSettings);
      config.ModelSettings = resolvedModelSettings;
    }

    agent.updateConfig(config);
  }

  // Destroy an agent
  async destroyAgent(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Agent with ID "${id}" not found`);
    }
    // destroy the agent's kernel if it has one
    const kernelId = agent.kernel?.id;
    agent.destroy();
    if (kernelId) {
      await this.kernelManager.destroyKernel(kernelId);
    }
    this.agents.delete(id);
  }

  // Destroy all agents
  async destroyAll(namespace?: string): Promise<void> {
    const agentIds = Array.from(this.agents.keys())
      .filter(id => {
        if (!namespace) return true;
        return id.startsWith(`${namespace}:`);
      });
    await Promise.all(agentIds.map(id => this.destroyAgent(id)));
  }

  // Attach a kernel to an agent
  async attachKernelToAgent(agentId: string, kernelType: KernelType): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent with ID "${agentId}" not found`);
    }

    if (!this.kernelManager) {
      throw new Error("Kernel manager not set. Use setKernelManager() first.");
    }

    // Create or get a kernel instance
    const kernelLanguageMap: Record<KernelType, KernelLanguage> = {
      [KernelType.PYTHON]: KernelLanguage.PYTHON,
      [KernelType.TYPESCRIPT]: KernelLanguage.TYPESCRIPT, 
      [KernelType.JAVASCRIPT]: KernelLanguage.JAVASCRIPT
    };

    const kernelLanguage = kernelLanguageMap[kernelType];
    
    // Prepare kernel creation options with environment variables
    const kernelOptions: any = {
      lang: kernelLanguage,
    };
    
    // Add environment variables if the agent has them
    if (agent.kernelEnvirons) {
      kernelOptions.env = agent.kernelEnvirons;
    }
    
    // createKernel returns a kernel ID, not the instance
    const kernelId = await this.kernelManager.createKernel(kernelOptions);

    // Get the actual kernel instance using the ID
    const kernelInstance = this.kernelManager.getKernel(kernelId);
    
    if (!kernelInstance) {
      throw new Error(`Failed to retrieve kernel instance with ID: ${kernelId}`);
    }

    await agent.attachKernel(kernelInstance);
  }

  // Detach kernel from an agent
  async detachKernelFromAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent with ID "${agentId}" not found`);
    }

    if (agent.kernel && this.kernelManager) {
      // Destroy the kernel through the manager
      await this.kernelManager.destroyKernel(agent.kernel.id);
    }

    agent.detachKernel();
  }

  // Save conversation to file
  async saveConversation(agentId: string, filename?: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent with ID "${agentId}" not found`);
    }

    // Ensure directory exists before saving
    try {
      await ensureDir(this.agentDataDirectory);
    } catch (error) {
      console.error(`Failed to create agent data directory: ${error}`);
    }

    const saveData: IConversationData = {
      agentId,
      messages: agent.conversationHistory,
      savedAt: new Date(),
      metadata: {
        agentName: agent.name,
        agentDescription: agent.description
      }
    };

    // Sanitize agent ID for safe filename by replacing problematic characters
    const safeAgentId = agentId.replace(/[:|@/\\<>*?"]/g, '_');
    const fileName = filename || `conversation_${safeAgentId}_${Date.now()}.json`;
    const filePath = join(this.agentDataDirectory, fileName);

    await Deno.writeTextFile(filePath, JSON.stringify(saveData, null, 2));
  }

  // Load conversation from file
  async loadConversation(agentId: string, filename?: string): Promise<ChatMessage[]> {
    if (!filename) {
      // If no filename provided, try to find the most recent conversation file for this agent
      const files = [];
      try {
        // Sanitize agent ID to match saved filenames
        const safeAgentId = agentId.replace(/[:|@/\\<>*?"]/g, '_');
        for await (const entry of Deno.readDir(this.agentDataDirectory)) {
          if (entry.isFile && entry.name.includes(`conversation_${safeAgentId}_`)) {
            files.push(entry.name);
          }
        }
      } catch {
        return [];
      }

      if (files.length === 0) {
        return [];
      }

      // Sort by timestamp (newest first)
      files.sort().reverse();
      filename = files[0];
    }

    const filePath = join(this.agentDataDirectory, filename);
    
    try {
      const content = await Deno.readTextFile(filePath);
      const saveData: IConversationData = JSON.parse(content);
      return saveData.messages;
    } catch {
      return [];
    }
  }

  // Clear agent's conversation history
  async clearConversation(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent with ID "${agentId}" not found`);
    }

    agent.conversationHistory = [];
  }

  // Set agent's conversation history
  async setConversationHistory(agentId: string, messages: ChatMessage[]): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent with ID "${agentId}" not found`);
    }

    agent.setConversationHistory(messages);
  }

  // Get agent statistics
  getStats(): {
    totalAgents: number;
    agentsWithKernels: number;
    maxAgents: number;
    agentsByKernelType: Record<string, number>;
    autoSaveConversations: boolean;
    dataDirectory: string;
    modelRegistry: {
      totalModels: number;
      modelsInUse: number;
      allowCustomModels: boolean;
      allowedModels?: string[];
    };
  } {
    const agentsByKernelType: Record<string, number> = {};
    let agentsWithKernels = 0;

    for (const agent of this.agents.values()) {
      if (agent.kernel) {
        agentsWithKernels++;
      }
      
      if (agent.kernelType) {
        agentsByKernelType[agent.kernelType] = (agentsByKernelType[agent.kernelType] || 0) + 1;
      }
    }

    // Count models in use
    const modelsInUse = new Set<string>();
    for (const agent of this.agents.values()) {
      // Try to find which model from registry this agent is using
      for (const [modelId, entry] of this.modelRegistry.entries()) {
        if (agent.ModelSettings.model === entry.modelSettings.model &&
            agent.ModelSettings.baseURL === entry.modelSettings.baseURL) {
          modelsInUse.add(modelId);
          break;
        }
      }
    }

    return {
      totalAgents: this.agents.size,
      agentsWithKernels,
      maxAgents: this.maxAgents,
      agentsByKernelType,
      autoSaveConversations: this.autoSaveConversations,
      dataDirectory: this.agentDataDirectory,
      modelRegistry: {
        totalModels: this.modelRegistry.size,
        modelsInUse: modelsInUse.size,
        allowCustomModels: this.allowCustomModels,
        allowedModels: this.allowedModels
      }
    };
  }

  // Get auto-save setting
  getAutoSaveConversations(): boolean {
    return this.autoSaveConversations;
  }

  // Set auto-save conversations
  setAutoSaveConversations(enabled: boolean): void {
    this.autoSaveConversations = enabled;
  }

  // Clean up old agents in a namespace to make room for new ones
  async cleanupOldAgentsInNamespace(namespace: string, keepCount: number = 5): Promise<number> {
    const namespaceAgents = Array.from(this.agents.entries())
      .filter(([id]) => id.startsWith(`${namespace}:`))
      .map(([id, agent]) => ({ id, agent }));

    if (namespaceAgents.length <= keepCount) {
      return 0; // No cleanup needed
    }

    // Sort by last used time (oldest first), then by creation time
    namespaceAgents.sort((a, b) => {
      const aTime = a.agent.lastUsed?.getTime() || a.agent.created.getTime();
      const bTime = b.agent.lastUsed?.getTime() || b.agent.created.getTime();
      return aTime - bTime;
    });

    // Remove oldest agents to get down to keepCount
    const agentsToRemove = namespaceAgents.slice(0, namespaceAgents.length - keepCount);
    
    for (const { id } of agentsToRemove) {
      try {
        await this.destroyAgent(id);
        console.log(`🧹 Cleaned up old agent: ${id}`);
      } catch (error) {
        console.error(`❌ Failed to cleanup agent ${id}:`, error);
      }
    }

    return agentsToRemove.length;
  }

  // ===== MODEL REGISTRY METHODS =====

  /**
   * Add a model to the registry
   * @param id Unique identifier for the model
   * @param modelSettings The model settings
   * @returns True if added successfully, false if ID already exists
   */
  public addModel(id: string, modelSettings: ModelSettings): boolean {
    if (this.modelRegistry.has(id)) {
      return false;
    }

    const entry: IModelRegistryEntry = {
      id,
      modelSettings: { ...modelSettings },
      created: new Date()
    };

    this.modelRegistry.set(id, entry);

    this.emit(ModelEvents.MODEL_ADDED, {
      modelId: id,
      data: { 
        id, 
        model: modelSettings.model,
        baseURL: modelSettings.baseURL,
        temperature: modelSettings.temperature,
        created: entry.created
      }
    });

    return true;
  }

  /**
   * Remove a model from the registry
   * @param id Model ID to remove
   * @returns True if removed successfully, false if not found
   */
  public removeModel(id: string): boolean {
    const entry = this.modelRegistry.get(id);
    if (!entry) {
      return false;
    }

    // Check if any agents are using this model
    const agentsUsingModel = Array.from(this.agents.values())
      .filter(agent => {
        // Check if this agent's model settings match the registry entry
        return agent.ModelSettings.model === entry.modelSettings.model &&
               agent.ModelSettings.baseURL === entry.modelSettings.baseURL;
      });

    if (agentsUsingModel.length > 0) {
      throw new Error(`Cannot remove model ${id}: it is being used by ${agentsUsingModel.length} agent(s)`);
    }

    this.modelRegistry.delete(id);

    this.emit(ModelEvents.MODEL_REMOVED, {
      modelId: id,
      data: { id, model: entry.modelSettings.model }
    });

    return true;
  }

  /**
   * Update a model in the registry
   * @param id Model ID to update
   * @param modelSettings New model settings
   * @returns True if updated successfully, false if not found
   */
  public updateModel(id: string, modelSettings: ModelSettings): boolean {
    const entry = this.modelRegistry.get(id);
    if (!entry) {
      return false;
    }

    const oldSettings = { ...entry.modelSettings };
    entry.modelSettings = { ...modelSettings };

    this.emit(ModelEvents.MODEL_UPDATED, {
      modelId: id,
      data: { 
        id, 
        oldSettings,
        newSettings: modelSettings
      }
    });

    return true;
  }

  /**
   * Get a model from the registry
   * @param id Model ID
   * @returns Model entry or undefined if not found
   */
  public getModel(id: string): IModelRegistryEntry | undefined {
    return this.modelRegistry.get(id);
  }

  /**
   * List all models in the registry
   * @returns Array of model entries
   */
  public listModels(): IModelRegistryEntry[] {
    return Array.from(this.modelRegistry.values());
  }

  /**
   * Check if a model exists in the registry
   * @param id Model ID
   * @returns True if model exists
   */
  public hasModel(id: string): boolean {
    return this.modelRegistry.has(id);
  }

  /**
   * Change the model for an existing agent
   * @param agentId Agent ID
   * @param modelId Name of the model from registry
   * @returns Promise resolving when model is changed
   */
  public async changeAgentModel(agentId: string, modelId: string): Promise<void> {
    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const modelEntry = this.modelRegistry.get(modelId);
    if (!modelEntry) {
      throw new Error(`Model ${modelId} not found in registry`);
    }

    // Check if model is allowed
    if (this.allowedModels && !this.allowedModels.includes(modelId)) {
      throw new Error(`Model ${modelId} is not in the allowed models list`);
    }

    // Update the agent's model settings
    agent.ModelSettings = { ...modelEntry.modelSettings };

    // Update last used time for the model
    modelEntry.lastUsed = new Date();

    console.log(`✅ Changed model for agent ${agentId} to ${modelId}`);
  }

  /**
   * Get model usage statistics
   * @returns Model usage statistics
   */
  public getModelStats(): {
    totalModels: number;
    modelsInUse: number;
    allowCustomModels: boolean;
    allowedModels?: string[];
    modelUsage: Array<{
      id: string;
      model: string;
      baseURL: string;
      temperature: number;
      agentsUsing: number;
      lastUsed?: Date;
      created: Date;
    }>;
  } {
    const modelUsage: Array<{
      id: string;
      model: string;
      baseURL: string;
      temperature: number;
      agentsUsing: number;
      lastUsed?: Date;
      created: Date;
    }> = [];

    let modelsInUse = 0;

    for (const [id, entry] of this.modelRegistry.entries()) {
      // Count agents using this model
      const agentsUsing = Array.from(this.agents.values())
        .filter(agent => {
          return agent.ModelSettings.model === entry.modelSettings.model &&
                 agent.ModelSettings.baseURL === entry.modelSettings.baseURL;
        }).length;

      if (agentsUsing > 0) {
        modelsInUse++;
      }

      modelUsage.push({
        id,
        model: entry.modelSettings.model,
        baseURL: entry.modelSettings.baseURL,
        temperature: entry.modelSettings.temperature,
        agentsUsing,
        lastUsed: entry.lastUsed,
        created: entry.created
      });
    }

    // Sort by usage (most used first), then by last used
    modelUsage.sort((a, b) => {
      if (a.agentsUsing !== b.agentsUsing) {
        return b.agentsUsing - a.agentsUsing;
      }
      if (a.lastUsed && b.lastUsed) {
        return b.lastUsed.getTime() - a.lastUsed.getTime();
      }
      if (a.lastUsed && !b.lastUsed) return -1;
      if (!a.lastUsed && b.lastUsed) return 1;
      return b.created.getTime() - a.created.getTime();
    });

    return {
      totalModels: this.modelRegistry.size,
      modelsInUse,
      allowCustomModels: this.allowCustomModels,
      allowedModels: this.allowedModels,
      modelUsage
    };
  }

  /**
   * Set allowed models list
   * @param allowedModels Array of allowed model IDs, or undefined to allow all
   */
  public setAllowedModels(allowedModels?: string[]): void {
    this.allowedModels = allowedModels;
  }

  /**
   * Set whether custom models are allowed
   * @param allow Whether to allow custom model settings
   */
  public setAllowCustomModels(allow: boolean): void {
    this.allowCustomModels = allow;
  }
} 