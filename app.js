// Updated the speech recognition section in app.js to improve functionality

// Event listener for the speak button
speakBtn.addEventListener('click', () => {
    // Start speech recognition
    recognition.start();
});

// Updating the minimum confidence threshold and handling results
recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    const confidence = event.results[0][0].confidence;

    // Adjusting the confidence threshold
    const minConfidenceThreshold = 0.7; // Lowered confidence threshold

    if (confidence > minConfidenceThreshold) {
        markWordAsCorrect(transcript);
        // Automatically advance to the next word
        advanceToNextWord();
        provideFeedback('Great job! Next word is...');
    } else {
        provideFeedback('Please try again.');
        logError(transcript); // Improved error handling
    }
};

// Function to mark the word as correct
function markWordAsCorrect(word) {
    // Implementation for marking the word
}

// Function to advance to the next word
function advanceToNextWord() {
    // Implementation to show the next word
}

// Function to provide user feedback
function provideFeedback(message) {
    feedbackElement.innerText = message;
}

// Function to log errors for further analysis
function logError(transcript) {
    console.error('Recognition error with transcript:', transcript);
}