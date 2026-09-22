let bufferStart = 0;
let bufferEnd = 0;
let currentPosition = 0;


/*
 * ---------------------------------------------------------
 * Utility
 * ---------------------------------------------------------
 */

function formatTime(seconds)
{
    seconds = Math.max(0, Math.floor(seconds));

    let hours = Math.floor(seconds / 3600);

    seconds %= 3600;

    let minutes = Math.floor(seconds / 60);

    seconds %= 60;

    if (hours > 0)
    {
        return (
            hours + ":" +
            String(minutes).padStart(2, "0") + ":" +
            String(seconds).padStart(2, "0")
        );
    }

    return (
        String(minutes).padStart(2, "0") +
        ":" +
        String(seconds).padStart(2, "0")
    );
}


/*
 * ---------------------------------------------------------
 * Quality color
 * ---------------------------------------------------------
 */

function qualityColor(value)
{
    value = Math.max(0, Math.min(1, value));

    /*
     * Red → yellow → green
     */

    let hue = value * 120;

    return `hsl(${hue}, 80%, 45%)`;
}


/*
 * ---------------------------------------------------------
 * Update buffer
 * ---------------------------------------------------------
 */

async function updateBuffer()
{
    try
    {
        let response =
            await fetch("/api/buffer");

        let data =
            await response.json();

        bufferStart = data.start;
        bufferEnd = data.end;

        document.getElementById(
            "buffer-status"
        ).textContent =
            "Buffer: " +
            formatTime(data.duration);

        drawQualityBar(data.segments);

        updatePosition();

    }
    catch (error)
    {
        console.error(error);
    }
}


/*
 * ---------------------------------------------------------
 * Draw signal-quality timeline
 * ---------------------------------------------------------
 */

function drawQualityBar(segments)
{
    let bar =
        document.getElementById("quality-bar");

    bar.innerHTML = "";

    for (let segment of segments)
    {
        let element =
            document.createElement("div");

        element.className =
            "quality-segment";

        element.style.background =
            qualityColor(segment.quality);

        bar.appendChild(element);
    }
}


/*
 * ---------------------------------------------------------
 * Timeline position
 * ---------------------------------------------------------
 */

function updatePosition()
{
    let timeline =
        document.getElementById("timeline");

    let position =
        document.getElementById("position");

    let duration =
        bufferEnd - bufferStart;

    if (duration <= 0)
        return;

    let percentage =
        (currentPosition - bufferStart)
        / duration;

    percentage =
        Math.max(0, Math.min(1, percentage));

    position.style.left =
        `${percentage * 100}%`;

    document.getElementById(
        "current-time"
    ).textContent =
        formatTime(currentPosition - bufferStart);
}


/*
 * ---------------------------------------------------------
 * Timeline click
 * ---------------------------------------------------------
 */

document
    .getElementById("timeline")
    .addEventListener("click", function(event)
    {

    if (bufferEnd <= bufferStart)
        return;

    let rect =
        this.getBoundingClientRect();

    let percentage =
        (event.clientX - rect.left)
        / rect.width;

    percentage =
        Math.max(0, Math.min(1, percentage));

    currentPosition =
        bufferStart +
        percentage * (bufferEnd - bufferStart);

    updatePosition();

    /*
     * Actual video seeking will be added
     * once we switch to browser-friendly
     * segmented video.
     */
});


/*
 * ---------------------------------------------------------
 * LIVE
 * ---------------------------------------------------------
 */

function goLive()
{
    currentPosition = bufferEnd;

    updatePosition();
}


/*
 * ---------------------------------------------------------
 * Jump backwards
 * ---------------------------------------------------------
 */

function jumpBack(seconds)
{
    currentPosition =
        Math.max(
            bufferStart,
            currentPosition - seconds
        );

    updatePosition();
}


/*
 * ---------------------------------------------------------
 * Update periodically
 * ---------------------------------------------------------
 */

setInterval(
    updateBuffer,
    1000
);

updateBuffer();
