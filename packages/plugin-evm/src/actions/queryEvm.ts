import {
    Action,
    ActionExample,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
} from "@ai16z/eliza";
import { elizaLogger as logger } from "@ai16z/eliza";
import getContractData from '../services/etherscan';
import { AbiFunction } from 'viem';
import { createPublicClient, http, Address, PublicClient, HttpTransport } from 'viem';
import { mainnet } from 'viem/chains';
import PlanAgent from '../agents/planAgent';
import ExecuteAgent from '../agents/executeAgent';
import CritiqueAgent from '../agents/critiqueAgent';
import { ExecutionPlan, Goal } from '../types/plan';

async function createAndCritiquePlan(
    planAgent: PlanAgent,
    critiqueAgent: CritiqueAgent,
    goal: string,
    context: {
        contractAddress: Address,
        chainId: string,
        sourceCode?: string,
        abi?: AbiFunction[]
    },
    params: { eoa?: string } // Add params parameter
): Promise<{ plan: ExecutionPlan, critique: { isValid: boolean, feedback: string } }> {
    const plan = await planAgent.createPlan(goal, params); // Pass params to createPlan
    const planSteps = plan.steps.map((step, index) =>
        `  ${index + 1}. ${step.functionName} - ${step.description}`
    ).join('\n');

    logger.info(
        `Plan Goal: ${plan.goal}\n` +
        'Plan Steps:\n' +
        planSteps
    );

    const critique = await critiqueAgent.critiquePlan(goal, plan, context);
    logger.info(`Plan Critique: ${critique.feedback}`);

    return { plan, critique };
}

const extractReadonlyFunctions = async (
    chainId: string,
    contractAddress: string,
    client: PublicClient) => {
    // Get initial contract data
    let { abi, sourceCode } = await getContractData(chainId, contractAddress);

    // Check if this is a proxy contract by looking for 'implementation' function
    const implementationFunction = abi.find((item: AbiFunction) =>
        item.type === 'function' &&
        (item.name === 'implementation' || item.name === 'getImplementation')
    );

    if (implementationFunction) {
        logger.info('Proxy contract detected, fetching implementation...');
        logger.debug('Implementation Function:', implementationFunction);

        try {
            // Call implementation function
            // @ts-ignore
            const implementationAddress = await client.readContract({
                address: contractAddress as Address,
                abi: [implementationFunction] as const,
                functionName: implementationFunction.name,
                args: []
            }) as Address;
            logger.info(`Implementation address: ${implementationAddress}`);

            // Get the actual contract data from the implementation
            const implementationData = await getContractData(chainId, implementationAddress);
            abi = implementationData.abi;
            sourceCode = implementationData.sourceCode;
        } catch (error) {
            logger.error('Failed to fetch implementation:', error);
        }
    }

    const functionAbis = abi.filter((item: AbiFunction) => item.type === 'function');
    const readonlyFunctions = functionAbis.filter((item: AbiFunction) =>
        item.stateMutability === 'view' || item.stateMutability === 'pure'
    );

    return {
        readonlyFunctions,
        abi,
        sourceCode
    }
}

const queryEVM = async (userIntent: string, runtime: IAgentRuntime) => {
    logger.info('starting web3 agents...');
    try {
        const planAgent = new PlanAgent();
        const critiqueAgent = new CritiqueAgent();

        // Get user intent from message. Should follow the pattern of evm query options that are available
        const goal: Goal = await planAgent.extractIntent(userIntent);

        logger.info(`intent extracted: ${JSON.stringify(goal, null, 2)}`);

        if (!goal) {
            return {
                success: false,
                error: "Unable to extract a valid smart contract query from intent"
            };
        }

        // Initialize Viem client
        const client = createPublicClient({
            chain: mainnet,
            transport: http(),
        }) as PublicClient;

        const chainId = '1';

        const { readonlyFunctions, abi, sourceCode } = await extractReadonlyFunctions(chainId, goal.contract, client)

        planAgent.readOnlyFunctions = readonlyFunctions
        planAgent.sourceCode = sourceCode

        const MAX_RETRIES = 5;
        let currentTry = 0;
        let validPlan: ExecutionPlan | null = null;

        while (currentTry < MAX_RETRIES) {
            currentTry++;
            logger.info(`Attempt ${currentTry}/${MAX_RETRIES} to create valid plan`);

            try {
                const { plan, critique } = await createAndCritiquePlan(
                    planAgent,
                    critiqueAgent,
                    goal.intent,
                    {
                        contractAddress: goal.contract as Address,
                        chainId,
                        sourceCode,
                        abi
                    },
                    { eoa: goal.eoa } // Pass the EOA address here
                );
                logger.debug(`Critique feedback: ${critique.feedback}`);

                if (critique.isValid) {
                    logger.info(`Plan validation succeeded on attempt ${currentTry}.`);
                    validPlan = plan;
                    break;
                }
                else {
                    logger.warn(`Plan validation failed on attempt ${currentTry}. Retrying with feedback...`);
                }


                // Pass the critique feedback to the PlanAgent for the next attempt
                planAgent.incorporateFeedback(critique.feedback);

            } catch (error) {
                logger.error(`Error on attempt ${currentTry}:`, error);
            }
        }

        if (!validPlan) {
            logger.error(`Failed to create valid plan after ${MAX_RETRIES} attempts`);
            return {
                success: false,
                error: `Failed to create valid plan after ${MAX_RETRIES} attempts`
            };
        }

        logger.info(`Valid plan found after ${currentTry} attempts.`);
        logger.info(`Plan Goal: ${validPlan.goal}`);
        logger.info(`Plan Steps: ${validPlan.steps.map((step, index) => `  ${index + 1}. ${step.functionName} - ${step.description}`).join('\n')}`);

        // Create and use ExecuteAgent with the valid plan
        const executeAgent = new ExecuteAgent(client, goal.contract as Address, abi);
        const executionResult = await executeAgent.executePlan(validPlan);
        return {
            success: true,
            data: {
                expectedOutput: executionResult.expectedOutput.description,
                actualOutput: executionResult.actualOutput
            }
        }
    } catch (error) {
        logger.error("Query EVM error:", error);
        return {
            success: false,
            error: error.message || "Unknown error occurred",
        };
    }
};

export default {
    name: "QUERY_EVM",
    similes: [
        "ASK_EVM",
        "GET_CHAIN_DATA",
        "GET_BLOCK",
        "GET_EVM_BALANCE",
        "GET_TRANSACTION_DETAILS"
    ],
    description: "Query EVM chain based on prompt",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        logger.log("Validate EVM query generation");
        const etherscan_api_key = runtime.getSetting("ETHERSCAN_API_KEY");
        logger.log("ETHERSCAN_API_KEY present:", !!etherscan_api_key);
        return !!etherscan_api_key;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        logger.log("EVM query request:", message.content);

        callback({
            text: `hang tight, querying substrate...`,
        });

        try {
            const evmQuery = message.content.text
            const result = await queryEVM(evmQuery, runtime);
            if (result.success && result.data) {
                const outputValue = typeof result.data.actualOutput === 'object' && result.data.actualOutput !== null
                    ? result.data.actualOutput.formatted ?? result.data.actualOutput.raw
                    : result.data.actualOutput;

                callback({
                    text: `${result.data.expectedOutput} : ${outputValue}`,
                    content: result.data
                });
            } else {
                callback({
                    text: `EVM query failed: ${result.error}`,
                    error: true,
                });
            }
        } catch (error) {
            logger.error(`Failed to query EVM. Error: ${error}`);
            callback({
                text: `Error querying EVM: ${error.message}`,
                content: { error: error.message }
            });
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "How much PEPE does this address hold 0x16b2b042f15564bb8585259f535907f375bdc415" },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Getting balance details for you"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What's the eth balance of this address 0x16b2b042f15564bb8585259f535907f375bdc415",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "This address holds 10 ETH"
                },
            },
        ],
    ] as ActionExample[][],
} as Action;