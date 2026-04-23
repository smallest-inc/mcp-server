import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerInviteMember(server: McpServer) {
  server.registerTool(
    "invite_member",
    {
      description:
        "Invite one or more users to your organization by email. They'll receive an invitation email to join. " +
        "Requires admin role on the organization. You can invite as 'member' (default) or 'admin'.",
      inputSchema: {
        emails: z
          .array(z.string())
          .describe("Email addresses to invite (e.g. ['alice@company.com', 'bob@company.com'])"),
        role: z
          .enum(["member", "admin"])
          .default("member")
          .describe("Role to assign to invited users. Default: member."),
      },
    },
    async (params) => {
      const invitedMembers = params.emails.map((email) => ({
        userEmail: email.trim(),
        role: params.role,
      }));

      const result = await atomsApi("POST", "/invitation/handle-invite-members", {
        invitedMembers,
      });

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: `Invitation${params.emails.length > 1 ? "s" : ""} sent`,
                summary: data?.summary,
                invites: data?.invites,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
