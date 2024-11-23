import { Plugin } from "@ai16z/eliza";
import queryEVM from "./actions/queryEvm"

export const evmPlugin: Plugin = {
    name: "evm",
    description: "Generic EVM plugin for eliza",
    actions: [queryEVM],
    evaluators: [],
    providers: [],
};
