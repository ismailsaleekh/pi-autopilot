import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import autopilotExtension from "../src/extension.ts";
import {
  PLAN_REVIEW_TOOL_PARAMETERS,
  PLAN_REVIEW_TOOL_SCHEMA_DIGEST,
  QUESTIONS_TOOL_PARAMETERS,
  QUESTIONS_TOOL_SCHEMA_DIGEST,
  SCOUT_DOSSIER_TOOL_PARAMETERS,
  SCOUT_DOSSIER_TOOL_SCHEMA_DIGEST,
  TASK_ATOMS_TOOL_PARAMETERS,
  TASK_ATOMS_TOOL_SCHEMA_DIGEST,
  WORK_MAP_TOOL_PARAMETERS,
  WORK_MAP_TOOL_SCHEMA_DIGEST,
} from "../src/generated/tool-schemas.ts";

interface PlanningCarrierDetails {
  readonly boundary_id: string;
  readonly schema_digest: string;
  readonly payload: Record<string, unknown>;
}

export default function autopilot(pi: ExtensionAPI): void {
  autopilotExtension(pi);
  registerPlanningSubmitTools(pi);
}

function registerPlanningSubmitTools(pi: ExtensionAPI): void {
  const register = (definition: {
    readonly name: string;
    readonly label: string;
    readonly boundary_id: string;
    readonly schema_digest: string;
    readonly parameters: typeof TASK_ATOMS_TOOL_PARAMETERS;
  }): void => {
    pi.registerTool(defineTool({
      name: definition.name,
      label: definition.label,
      description: `Submit the final ${definition.boundary_id} payload. Use this as the final action; assistant prose is not a carrier.`,
      promptSnippet: `Submit ${definition.boundary_id} as a terminating typed Autopilot carrier`,
      promptGuidelines: [
        `Call ${definition.name} exactly once as the final action for ${definition.boundary_id}.`,
        "Do not return the payload as assistant prose or markdown.",
      ],
      parameters: definition.parameters,
      async execute(_toolCallId, params) {
        const payload = params as Record<string, unknown>;
        const details: PlanningCarrierDetails = {
          boundary_id: definition.boundary_id,
          schema_digest: definition.schema_digest,
          payload,
        };
        pi.appendEntry("pi-autopilot:planning-carrier", details);
        return {
          content: [{ type: "text", text: `Submitted ${definition.boundary_id} (${definition.schema_digest})` }],
          details,
          terminate: true,
        };
      },
    }));
  };

  register({
    name: "autopilot_submit_atoms",
    label: "Submit task atoms",
    boundary_id: "planning.task-atoms.v1",
    schema_digest: TASK_ATOMS_TOOL_SCHEMA_DIGEST,
    parameters: TASK_ATOMS_TOOL_PARAMETERS,
  });
  register({
    name: "autopilot_submit_scout_report",
    label: "Submit scout dossier",
    boundary_id: "planning.scout-dossier.v1",
    schema_digest: SCOUT_DOSSIER_TOOL_SCHEMA_DIGEST,
    parameters: SCOUT_DOSSIER_TOOL_PARAMETERS,
  });
  register({
    name: "autopilot_submit_plan_cluster",
    label: "Submit work map",
    boundary_id: "planning.work-map.v1",
    schema_digest: WORK_MAP_TOOL_SCHEMA_DIGEST,
    parameters: WORK_MAP_TOOL_PARAMETERS,
  });
  register({
    name: "autopilot_submit_synthesis",
    label: "Submit synthesized work map",
    boundary_id: "planning.work-map.v1",
    schema_digest: WORK_MAP_TOOL_SCHEMA_DIGEST,
    parameters: WORK_MAP_TOOL_PARAMETERS,
  });
  register({
    name: "autopilot_submit_review",
    label: "Submit plan review",
    boundary_id: "planning.plan-review.v1",
    schema_digest: PLAN_REVIEW_TOOL_SCHEMA_DIGEST,
    parameters: PLAN_REVIEW_TOOL_PARAMETERS,
  });
  register({
    name: "autopilot_submit_resolution",
    label: "Submit planning questions",
    boundary_id: "planning.questions.v1",
    schema_digest: QUESTIONS_TOOL_SCHEMA_DIGEST,
    parameters: QUESTIONS_TOOL_PARAMETERS,
  });
  register({
    name: "autopilot_submit_questions",
    label: "Submit planning questions",
    boundary_id: "planning.questions.v1",
    schema_digest: QUESTIONS_TOOL_SCHEMA_DIGEST,
    parameters: QUESTIONS_TOOL_PARAMETERS,
  });
}
