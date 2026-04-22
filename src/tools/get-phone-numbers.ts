import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { atomsApi, formatApiError } from "../api.js";
import type { IPhoneNumberEntry } from "../types.js";

export function registerGetPhoneNumbers(server: McpServer) {
  server.registerTool(
    "get_phone_numbers",
    {
      description:
        "List phone numbers acquired by your organization. Shows product ID (needed for make_call's from_product_id), number, country, provider, and which agent it's assigned to.",
      inputSchema: {},
    },
    async () => {
      const result = await atomsApi("GET", "/product/phone-numbers");

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;
      const numbers = (Array.isArray(data) ? data : (data?.numbers ?? [])).map((n: IPhoneNumberEntry) => ({
        productId: n._id,
        productType: n.productType,
        phoneNumber: n.attributes?.phoneNumber ?? n.phoneNumber,
        country: n.attributes?.countryCode ?? n.country,
        provider: n.attributes?.provider,
        assignedAgentId: n.agentId ?? n.agent?._id,
        assignedAgentName: n.agent?.name,
        isActive: n.isActive,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ count: numbers.length, numbers }, null, 2),
          },
        ],
      };
    }
  );
}
