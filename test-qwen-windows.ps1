#!/usr/bin/env pwsh

# Test script for running Qwen properly on Windows
# Uses the exact same approach as openrouter-supervisor.js but with actual input

Write-Host "Testing Qwen execution with proper Windows syntax"

# Set working directory to PROJECT_ROOT
$projectRoot = "E:\tools\AI\project\PromptDictionary"
Set-Location $projectRoot

# Create test prompt file
$testPrompt = "C#でList<int>から重複を削除する方法を1つだけ教えてください。"
$testFile = [System.IO.Path]::GetTempFileName()
Set-Content -Path $testFile -Value $testPrompt

Write-Host "Test prompt written to: $testFile"

# Run Qwen with proper Windows CMD syntax
try {
    $startTime = Get-Date
    Write-Host "Running: qwen -y -o json < `"$testFile`""
    
    # The main difference from the original - using PowerShell native execution
    $result = cmd /c "qwen -y -o json < `"$testFile`""
    
    $endTime = Get-Date
    $duration = $endTime - $startTime
    
    Write-Host "Qwen completed in $($duration.TotalMilliseconds) ms"
    Write-Host "Output:"
    Write-Host $result
    
} catch {
    Write-Error "Qwen execution failed: $_"
}

# Cleanup
Remove-Item -Path $testFile -Force