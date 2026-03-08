import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  IDataObject,
} from "n8n-workflow";
import { NodeConnectionTypes } from "n8n-workflow";

export class ReflectMemory implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Reflect Memory",
    name: "reflectMemory",
    icon: "file:reflectMemory.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: "Read, write, browse, and search memories in Reflect Memory",
    defaults: {
      name: "Reflect Memory",
    },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: "reflectMemoryApi",
        required: true,
      },
    ],
    usableAsTool: true,
    properties: [
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        options: [
          {
            name: "Browse",
            value: "browse",
            description: "Browse memory summaries (paginated)",
            action: "Browse memory summaries",
          },
          {
            name: "Get by ID",
            value: "getById",
            description: "Retrieve a memory by its UUID",
            action: "Retrieve a memory by its UUID",
          },
          {
            name: "Get by Tag",
            value: "getByTag",
            description: "Get memories filtered by tags",
            action: "Get memories filtered by tags",
          },
          {
            name: "Get Latest",
            value: "getLatest",
            description: "Get the most recent memory",
            action: "Get the most recent memory",
          },
          {
            name: "Write",
            value: "write",
            description: "Create a new memory",
            action: "Create a new memory",
          },
        ],
        default: "getLatest",
      },

      // --- Get Latest ---
      {
        displayName: "Tag",
        name: "tag",
        type: "string",
        default: "",
        description: "Optional tag to filter by",
        displayOptions: { show: { operation: ["getLatest"] } },
      },

      // --- Get by ID ---
      {
        displayName: "Memory ID",
        name: "memoryId",
        type: "string",
        default: "",
        required: true,
        description: "The UUID of the memory to retrieve",
        displayOptions: { show: { operation: ["getById"] } },
      },

      // --- Browse ---
      {
        displayName: "Limit",
        name: "limit",
        type: "number",
        default: 50,
        description: "Max number of results to return",
        typeOptions: { minValue: 1, maxValue: 200 },
        displayOptions: { show: { operation: ["browse"] } },
      },
      {
        displayName: "Offset",
        name: "offset",
        type: "number",
        default: 0,
        description: "Number of results to skip",
        typeOptions: { minValue: 0 },
        displayOptions: { show: { operation: ["browse"] } },
      },

      // --- Get by Tag ---
      {
        displayName: "Tags",
        name: "tags",
        type: "string",
        default: "",
        required: true,
        description: "Comma-separated list of tags to filter by",
        displayOptions: { show: { operation: ["getByTag"] } },
      },
      {
        displayName: "Limit",
        name: "tagLimit",
        type: "number",
        default: 20,
        description: "Max number of results to return",
        typeOptions: { minValue: 1, maxValue: 100 },
        displayOptions: { show: { operation: ["getByTag"] } },
      },
      {
        displayName: "Offset",
        name: "tagOffset",
        type: "number",
        default: 0,
        description: "Number of results to skip",
        typeOptions: { minValue: 0 },
        displayOptions: { show: { operation: ["getByTag"] } },
      },

      // --- Write ---
      {
        displayName: "Memory Type",
        name: "memory_type",
        type: "options",
        options: [
          { name: "Semantic", value: "semantic" },
          { name: "Episodic", value: "episodic" },
          { name: "Procedural", value: "procedural" },
        ],
        default: "semantic",
        description:
          "Memory classification: Semantic (facts/knowledge), Episodic (events/decisions), Procedural (workflows/patterns)",
        displayOptions: { show: { operation: ["write"] } },
      },
      {
        displayName: "Title",
        name: "title",
        type: "string",
        default: "",
        required: true,
        description: "Short title for the memory",
        displayOptions: { show: { operation: ["write"] } },
      },
      {
        displayName: "Content",
        name: "content",
        type: "string",
        default: "",
        required: true,
        typeOptions: { rows: 5 },
        description: "The memory content",
        displayOptions: { show: { operation: ["write"] } },
      },
      {
        displayName: "Tags",
        name: "writeTags",
        type: "string",
        default: "",
        description: "Comma-separated tags for categorization",
        displayOptions: { show: { operation: ["write"] } },
      },
      {
        displayName: "Allowed Vendors",
        name: "allowedVendors",
        type: "string",
        default: "*",
        description:
          'Comma-separated vendor names that can see this memory, or "*" for all',
        displayOptions: { show: { operation: ["write"] } },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    const credentials = await this.getCredentials("reflectMemoryApi");
    const baseUrl = (credentials.baseUrl as string).replace(/\/$/, "");

    for (let i = 0; i < items.length; i++) {
      const operation = this.getNodeParameter("operation", i) as string;
      let responseData: IDataObject | IDataObject[];

      try {
        switch (operation) {
          case "getLatest": {
            const tag = this.getNodeParameter("tag", i, "") as string;
            const qs = tag ? `?tag=${encodeURIComponent(tag)}` : "";
            responseData = await this.helpers.httpRequestWithAuthentication.call(
              this,
              "reflectMemoryApi",
              {
                method: "GET",
                url: `${baseUrl}/agent/memories/latest${qs}`,
                json: true,
              },
            ) as IDataObject;
            break;
          }

          case "getById": {
            const memoryId = this.getNodeParameter("memoryId", i) as string;
            responseData = await this.helpers.httpRequestWithAuthentication.call(
              this,
              "reflectMemoryApi",
              {
                method: "GET",
                url: `${baseUrl}/agent/memories/${encodeURIComponent(memoryId)}`,
                json: true,
              },
            ) as IDataObject;
            break;
          }

          case "browse": {
            const limit = this.getNodeParameter("limit", i) as number;
            const offset = this.getNodeParameter("offset", i) as number;
            responseData = await this.helpers.httpRequestWithAuthentication.call(
              this,
              "reflectMemoryApi",
              {
                method: "POST",
                url: `${baseUrl}/agent/memories/browse`,
                body: { limit, offset, filter: { by: "all" } },
                json: true,
              },
            ) as IDataObject;
            break;
          }

          case "getByTag": {
            const tagsStr = this.getNodeParameter("tags", i) as string;
            const tags = tagsStr.split(",").map((t) => t.trim()).filter(Boolean);
            const limit = this.getNodeParameter("tagLimit", i) as number;
            const offset = this.getNodeParameter("tagOffset", i) as number;
            responseData = await this.helpers.httpRequestWithAuthentication.call(
              this,
              "reflectMemoryApi",
              {
                method: "POST",
                url: `${baseUrl}/agent/memories/by-tag`,
                body: { tags, limit, offset },
                json: true,
              },
            ) as IDataObject;
            break;
          }

          case "write": {
            const memory_type = this.getNodeParameter("memory_type", i, "semantic") as string;
            const title = this.getNodeParameter("title", i) as string;
            const content = this.getNodeParameter("content", i) as string;
            const tagsStr = this.getNodeParameter("writeTags", i, "") as string;
            const tags = tagsStr
              ? tagsStr.split(",").map((t) => t.trim()).filter(Boolean)
              : [];
            const vendorsStr = this.getNodeParameter(
              "allowedVendors",
              i,
              "*",
            ) as string;
            const allowed_vendors = vendorsStr
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean);

            responseData = await this.helpers.httpRequestWithAuthentication.call(
              this,
              "reflectMemoryApi",
              {
                method: "POST",
                url: `${baseUrl}/agent/memories`,
                body: { title, content, tags, allowed_vendors, memory_type },
                json: true,
              },
            ) as IDataObject;
            break;
          }

          default:
            responseData = {};
        }

        if (Array.isArray(responseData)) {
          returnData.push(
            ...responseData.map((item) => ({ json: item })),
          );
        } else {
          returnData.push({ json: responseData ?? {} });
        }
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({
            json: { error: (error as Error).message },
            pairedItem: { item: i },
          });
          continue;
        }
        throw error;
      }
    }

    return [returnData];
  }
}
