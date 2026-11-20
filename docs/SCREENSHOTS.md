# OMOS queues screenshots

All screenshots and demos use dark mode and synthetic data in an isolated stock OpenChamber host. No real user settings or live configuration are shown.

The stills show OMOS queues 0.3.1 in OpenChamber 2.7.3, captured in Firefox at 1280 × 800 on desktop and 390 × 844 on an emulated phone. The phone capture is not a physical-device test.

## Queue editor on desktop

Fallback models are listed in order, with a variant selector and reorder controls for each position.

![Dark desktop queue editor showing model positions with variant and reorder controls.](screenshots/queue-editor-desktop.png)

## Model picker on desktop

The picker lets you search for a model to use in the selected queue position.

![Dark desktop model picker with a search field above available models and favorite stars.](screenshots/model-picker-desktop.png)

## Review on an emulated phone

The review shows what will change, with **Back to editing** and **Confirm and save** fixed at the bottom of the phone viewport.

![Dark review on an emulated phone showing added and removed configuration lines above the fixed editing and save actions.](screenshots/review-phone.png)

## Feature demos

Both demos stop before saving; the configuration file stays unchanged.

### Find a model

Open the picker, filter the list, and choose a model to stage it in the selected queue position.

<details>
<summary>Show the model picker GIF</summary>

![The model picker opens, narrows the results as a filter is entered, and stages the selected model in the queue.](screenshots/find-a-model.gif)

</details>

### Copy a queue and review the diff

Copy one queue and confirm the paste into another. Open **Review changes** to see the diff, then choose **Back to editing** without saving.

<details>
<summary>Show the copy and review GIF</summary>

![A queue is copied and pasted into another queue, the diff opens, and Back to editing returns to the draft without saving.](screenshots/copy-and-review.gif)

</details>
