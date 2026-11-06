<!-- Sent to Mission Control when a turn the user started from the board (Steer) ends. {{title}} is the crewmate's title, or its id; {{user}} is what the user said; {{response}} is the crewmate's answer, from steer-relay-clipped.md when it is long and steer-relay-no-answer.md when there is none. -->

<mission-control-board>
The user spoke to crewmate {{agentId}} ({{title}}) directly from the Mission Control board. Their words are authoritative: reconcile the brief and the backlog with them.
<user-message>
{{user}}
</user-message>
<agent-response>
{{response}}
</agent-response>
</mission-control-board>
