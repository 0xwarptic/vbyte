export interface PlanStep {
  functionName: string;
  description: string;
  inputs: {
    name: string;
    type: string;
    value?: any;
  }[];
  expectedOutput: string;
}

export interface ExecutionPlan {
  goal: string;
  steps: PlanStep[];
}

export interface Goal {
  intent: string,
  contract: string,
  eoa: string
}