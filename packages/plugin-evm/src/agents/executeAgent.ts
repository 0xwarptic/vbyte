import { AbiFunction, Address, PublicClient } from 'viem';
import { elizaLogger as logger } from "@ai16z/eliza";
import { ExecutionPlan } from '../types/plan';

interface ExecutionResult {
  expectedOutput: any;
  actualOutput: any;
}

async function formatTokenAmount(
  client: PublicClient,
  contractAddress: Address,
  abi: AbiFunction[],
  amount: bigint
): Promise<string> {
  try {
    // Check if decimals() function exists in ABI
    const decimalsFunction = abi.find(item =>
      item.type === 'function' &&
      item.name === 'decimals'
    );

    if (!decimalsFunction) {
      // If no decimals function, return raw string
      return amount.toString();
    }

    const decimals = await client.readContract({
      address: contractAddress,
      abi: [decimalsFunction],
      functionName: 'decimals'
    }) as number;

    const stringAmount = amount.toString();
    if (stringAmount.length <= decimals) {
      return `0.${stringAmount.padStart(decimals, '0')}`;
    }
    const integerPart = stringAmount.slice(0, -decimals);
    const decimalPart = stringAmount.slice(-decimals);
    return `${integerPart}.${decimalPart}`;
  } catch (error) {
    // If anything goes wrong, return raw string
    logger.warn('Failed to format token amount:', error);
    return amount.toString();
  }
}

function processOutput(value: any): any {
  // Handle different types of outputs
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(processOutput);
  }

  if (value && typeof value === 'object') {
    const newObj: any = {};
    for (const [key, val] of Object.entries(value)) {
      newObj[key] = processOutput(val);
    }
    return newObj;
  }

  // Return other types as-is
  return value;
}

export default class ExecuteAgent {
  private client: PublicClient;
  private contractAddress: Address;
  private abi: AbiFunction[];
  private stepOutputs: Map<number, any>;

  constructor(client: PublicClient, contractAddress: Address, abi: AbiFunction[]) {
    this.client = client;
    this.contractAddress = contractAddress;
    this.abi = abi;
    this.stepOutputs = new Map();
  }

  async executePlan(plan: ExecutionPlan): Promise<ExecutionResult> {
    logger.info('Executing plan...');

    if (plan.steps.length === 0) {
      throw new Error('No steps found in execution plan');
    }

    for (const [index, step] of plan.steps.entries()) {
      try {
        logger.info(`Step ${index + 1}: ${step.functionName}`);
        logger.info(`Description: ${step.description}`);

        const processedArgs = step.inputs.map(input => {
          const inputValue = input.value;
          if (typeof inputValue === 'string' && inputValue.startsWith('<retrieved ')) {
            const referencedFunction = inputValue.replace('<retrieved ', '').replace('>', '');

            const previousStep = plan.steps.findIndex(s => s.functionName === referencedFunction);
            if (previousStep === -1 || !this.stepOutputs.has(previousStep)) {
              throw new Error(`Referenced output from ${referencedFunction} not found`);
            }

            return this.stepOutputs.get(previousStep);
          }
          return input.value;
        });

        if (step.inputs.length > 0) {
          logger.info('Inputs:');
          step.inputs.forEach((input, i) => {
            logger.info(`  - ${input.name} (${input.type}): ${processedArgs[i]}`);
          });
        }

        logger.info('Expected Output:', step.expectedOutput);

        logger.debug('Executing contract call with:', {
          address: this.contractAddress,
          functionName: step.functionName,
          args: processedArgs
        });

        const abiFunction = this.abi.find((item: AbiFunction) =>
          item.type === 'function' &&
          item.name === step.functionName
        );

        if (!abiFunction) {
          throw new Error(`ABI function not found for ${step.functionName}`);
        }

        const output = await this.client.readContract({
          address: this.contractAddress,
          abi: [abiFunction],
          functionName: step.functionName,
          args: processedArgs
        });

        // Store raw output for potential future steps
        this.stepOutputs.set(index, output);

        // Process the output - handle balance formatting specially
        let processedOutput;
        if (
          typeof output === 'bigint' &&
          (step.functionName === 'balanceOf' || step.functionName === 'balance')
        ) {
          try {
            const formatted = await formatTokenAmount(
              this.client,
              this.contractAddress,
              this.abi,
              output
            );
            processedOutput = {
              raw: (output as bigint).toString(), // Simple toString() for BigInt
              formatted
            };
          } catch (error) {
            logger.warn('Failed to format token amount:', error);
            processedOutput = (output as bigint).toString(); // Fallback to simple string conversion
          }
        } else {
          processedOutput = processOutput(output);
        }

        logger.info('Actual Output:', processedOutput);

        // If this is the last step, return both expected and actual output
        if (index === plan.steps.length - 1) {
          return {
            expectedOutput: processOutput(step.expectedOutput),
            actualOutput: processedOutput
          };
        }
      } catch (error) {
        logger.error(`Error executing step ${index + 1} (${step.functionName}):`, error);
        throw error;
      }
    }

    // This should never be reached due to the initial length check,
    // but TypeScript needs it for type safety
    throw new Error('No steps were executed');
  }
} 