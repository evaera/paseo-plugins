<!-- Fills {{crewFastRule}} in the charter when the Mission Control settings turn fast mode on for the crew. -->

- `settings.features`: `{"fast_mode": true}`, the user's choice of fast mode for the crew, wherever the
     model offers a `fast_mode` toggle (`inspect_provider` lists it under `features`); leave it out where it
     does not, and wherever the user says otherwise for a task;
