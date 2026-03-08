import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from "n8n-workflow";

export class ReflectMemoryApi implements ICredentialType {
  name = "reflectMemoryApi";
  displayName = "Reflect Memory API";
  documentationUrl = "https://reflectmemory.com/docs";
  icon = { light: "file:../nodes/ReflectMemory/reflectMemory.svg", dark: "file:../nodes/ReflectMemory/reflectMemory.svg" } as const;

  properties: INodeProperties[] = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      description: "Your Reflect Memory agent API key (RM_AGENT_KEY_*)",
    },
    {
      displayName: "Base URL",
      name: "baseUrl",
      type: "string",
      default: "https://api.reflectmemory.com",
      description: "Base URL of your Reflect Memory instance",
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: {
      headers: {
        Authorization: "=Bearer {{$credentials.apiKey}}",
      },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL: "={{$credentials.baseUrl}}",
      url: "/whoami",
      method: "GET",
    },
  };
}
