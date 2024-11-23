import { AbiFunction } from 'viem';
import { elizaLogger as logger } from "@ai16z/eliza";
import OpenAI from 'openai';
import { ExecutionPlan, Goal } from '../types/plan';

export default class PlanAgent {
  private openai: OpenAI;
  private lastCritique: string | null = null;
  private _readOnlyFunctions: AbiFunction[];
  private _sourceCode?: string;

  constructor() {
    logger.info('Initializing Plan Agent...');

    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    if (!process.env.OPENAI_BASE_URL) {
      throw new Error('OPENAI_BASE_URL environment variable is required');
    }

    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL
    });
  }

  // Getters
  public get readOnlyFunctions(): AbiFunction[] {
    return this._readOnlyFunctions;
  }

  public get sourceCode(): string | undefined {
    return this._sourceCode;
  }

  // Setters
  public set readOnlyFunctions(functions: AbiFunction[]) {
    this._readOnlyFunctions = functions;
  }

  public set sourceCode(code: string | undefined) {
    this._sourceCode = code;
  }

  public incorporateFeedback(feedback: string): void {
    this.lastCritique = feedback;
  }

  async extractIntent(intent: string): Promise<Goal> {
    logger.info("Extracting goal from user intent....");
    logger.debug(`Intent: ${intent}`);

    const systemPrompt = `
  You are a blockchain expert who extracts structured intents from natural language queries about smart contracts.
  Given a user's question, determine if it requires interacting with a smart contract.
  If it does, extract the contract address, user address (if any), and classify the intent.
  Only return structured data if the query requires smart contract interaction.
  
  Example inputs and outputs:
  
  Input: "how much PEPE (0x6982508145454Ce325dDbE47a25d4ec3d2311933) does this address hold 0x16b2b042f15564bb8585259f535907f375bdc415 on ethereum?"
  Output: {
    "intent": "get user balance for token",
    "contract": "0x6982508145454Ce325dDbE47a25d4ec3d2311933",
    "eoa": "0x16b2b042f15564bb8585259f535907f375bdc415"
  }
  
  Input: "what's the total supply of USDC (0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48)?"
  Output: {
    "intent": "get token total supply",
    "contract": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "eoa": null
  }
  
  Input: "what's the current ethereum gas price?"
  Output: null // No smart contract interaction needed
  `;

    const extractFunction = {
      name: "extract_contract_intent",
      description: "Extract structured intent data from user query",
      parameters: {
        type: "object",
        properties: {
          intent: { type: "string" },
          contract: { type: "string" },
          eoa: { type: ["string", "null"] }
        },
        required: ["intent", "contract"]
      }
    };

    try {
      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{
          role: "system",
          content: systemPrompt
        }, {
          role: "user",
          content: intent
        }],
        tools: [{
          type: "function",
          function: extractFunction
        }],
        tool_choice: {
          type: "function",
          function: { name: "extract_contract_intent" }
        }
      });

      const toolCall = completion.choices[0].message.tool_calls?.[0];
      if (!toolCall) {
        throw new Error('No contract interaction needed');
      }

      return JSON.parse(toolCall.function.arguments) as Goal;

    } catch (error) {
      logger.error('Failed to extract intent:', error);
      throw new Error('Failed to extract smart contract intent');
    }
  }

  async createPlan(goal: string, params: { eoa?: string }): Promise<ExecutionPlan> {
    logger.info('Planning contract data exploration using AI...');
    logger.debug(`Goal: ${goal}`);

    const functionDescriptions = this.readOnlyFunctions.map(func => ({
      name: func.name,
      inputs: func.inputs || [],
      outputs: func.outputs || [],
      stateMutability: func.stateMutability
    }));

    const systemPrompt = `
You are a blockchain expert who creates structured plans for achieving a user's goal by calling smart contract functions.
    
You will create a structured plan that:
1. Has a clear goal
2. Lists specific function calls to make
3. Explains why each call is useful
4. Uses actual parameter values passed in instead of placeholders
`;
    let userPrompt = `# Goal:\n\n${goal}`;
    userPrompt += `\n\n## Available functions:\n\n\`\`\`json\n${JSON.stringify(functionDescriptions, null, 2)}\n\`\`\``;
    userPrompt += `\n\n## Parameters:\n\n\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\``;

    if (this.sourceCode) {
      userPrompt += `\n\n## Contract Source Code:\n\n\`\`\`solidity\n${this.sourceCode}\n\`\`\``;
    }

    // Include the previous critique in the prompt if it exists
    userPrompt += this.lastCritique
      ? `\n\n## Previous plan critique:\n\n${this.lastCritique}`
      : '';

    // Define the function for structured output
    const planFunction = {
      name: "create_execution_plan",
      description: "Create a structured plan for exploring a smart contract",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                functionName: { type: "string" },
                description: { type: "string" },
                inputs: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      type: { type: "string" },
                      value: { type: "string", optional: true }
                    },
                    required: ["name", "type"]
                  }
                },
                expectedOutput: {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                    description: { type: "string" }
                  },
                  required: ["type", "description"]
                }
              },
              required: ["functionName", "description", "inputs", "expectedOutput"]
            }
          },
          goal: { type: "string" }
        },
        required: ["steps", "goal"]
      }
    };

    try {
      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{
          role: "system",
          content: systemPrompt
        }, {
          role: "user",
          content: userPrompt
        }],
        tools: [{
          type: "function",
          function: planFunction
        }],
        tool_choice: {
          type: "function",
          function: { name: "create_execution_plan" }
        }
      });

      const toolCall = completion.choices[0].message.tool_calls?.[0];
      if (!toolCall) {
        throw new Error('No tool call found in response');
      }

      const plan = JSON.parse(toolCall.function.arguments) as ExecutionPlan;
      logger.debug(`AI Generated plan: ${plan.goal}`);
      return plan;

    } catch (error) {
      logger.error('Failed to generate AI plan:', error);
      throw new Error('Failed to generate AI plan');
    }
  }
}