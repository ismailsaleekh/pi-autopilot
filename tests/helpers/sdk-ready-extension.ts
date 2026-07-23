import autopilotExtension from '../../src/extension.ts';
import { sdkReadyRosterActivationStore } from './sdk-ready-roster.ts';

export default function sdkReadyAutopilotExtension(pi: Parameters<typeof autopilotExtension>[0]): void {
  autopilotExtension(pi, { rosterActivationStore: sdkReadyRosterActivationStore() });
}
