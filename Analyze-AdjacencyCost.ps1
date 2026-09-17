$ErrorActionPreference = 'Stop'

$FinalIndexPath = 'C:\Users\Administrator\Desktop\decide-design-v2-datacleaning-20260916-2151-main\final-noun-index.json'
$DocuversePath = 'C:\Users\Administrator\Desktop\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json'
$OutPath = 'C:\Users\Administrator\Desktop\decide-design-v2-datacleaning-20260916-2151-main\adjacency-analysis-result.json'
$NewtonsoftPath = 'Z:\Newtonsoft.Json.dll'

Add-Type -Path $NewtonsoftPath

$AdjacencyTolerance = 3

function Strip-HtmlTags([string]$text) {
    $text = [regex]::Replace($text, '</?(?:div|table|tr|td|th|thead|tbody|sup|sub|span|p|br)\b[^>]*>', '', 'IgnoreCase')
    $text = [regex]::Replace($text, '<[^>]+>', '')
    return $text
}

function Strip-LatexResidue([string]$text) {
    $text = [regex]::Replace($text, '\$\$[^$]*\$\$', ' ')
    $text = [regex]::Replace($text, '\$[^$\n]*\$', ' ')
    $text = [regex]::Replace($text, '\\[a-zA-Z]+(?:\{[^{}]*\})*', ' ')
    $text = [regex]::Replace($text, '\\+', ' ')
    $text = [regex]::Replace($text, '[\^_]\{[^{}]*\}', ' ')
    $text = [regex]::Replace($text, '\s{2,}', ' ')
    return $text
}

# Chinese literal strings built from code points to avoid source-encoding issues
$ZH_QING = [char]0x8BF7  # please
$ZH_YI = [char]0x4F9D
$ZH_JU = [char]0x636E
$ZH_KE = [char]0x53EF
$ZH_JIAN = [char]0x89C1
$ZH_BAN = [char]0x7248
$ZH_MIAN = [char]0x9762
$ZH_HUI = [char]0x56DE
$ZH_DA = [char]0x7B54
$ZH_JU_PERIOD = [char]0x3002
$ZH_WU = [char]0x52FF
$ZH_BIAN = [char]0x7F16
$ZH_ZAO = [char]0x9020
$ZH_WEI = [char]0x672A
$ZH_TI = [char]0x63D0
$ZH_GONG = [char]0x4F9B
$ZH_DE = [char]0x7684
$ZH_WEN = [char]0x6587
$ZH_ZI = [char]0x5B57
$ZH_WU2 = [char]0x65E0
$ZH_CENG = [char]0x5C42

$PAT1 = "$ZH_QING$ZH_YI$ZH_JU$ZH_KE$ZH_JIAN$ZH_BAN$ZH_MIAN$ZH_HUI$ZH_DA" + '[^' + $ZH_JU_PERIOD + ']*' + $ZH_JU_PERIOD + '?'
$PAT2 = "$ZH_WU$ZH_BIAN$ZH_ZAO$ZH_WEI$ZH_TI$ZH_GONG$ZH_DE$ZH_WEN$ZH_ZI" + '[^' + $ZH_JU_PERIOD + ']*' + $ZH_JU_PERIOD + '?'
$PAT3 = "$ZH_WU2$ZH_WEN$ZH_ZI$ZH_CENG" + '/' + "$ZH_WEI" + 'OCR' + '[^' + $ZH_JU_PERIOD + ']*' + $ZH_JU_PERIOD + '?'
$NO_TEXT_LAYER = "$ZH_WU2$ZH_WEN$ZH_ZI$ZH_CENG"
$NOT_OCR = "$ZH_WEI" + 'OCR'

function Get-JStr($token) {
    # Safely extract a string from a JToken without relying on truthy coercion
    if ($null -eq $token) { return $null }
    return [string]$token
}

function Get-AtomSearchText($chunk) {
    $faces = $chunk['faces']
    $text = $null
    if ($null -ne $faces) {
        $textFace = $faces['text']
        if ($null -ne $textFace) {
            $contentTok = $textFace['content']
            if ($null -ne $contentTok) {
                $s = Get-JStr $contentTok
                if ($null -ne $s) { $text = $s.Trim() }
            }
        }
    }
    if (($null -ne $text) -and ($text.Length -ge 8)) { return Strip-LatexResidue (Strip-HtmlTags $text) }

    $raw = ''
    $contentTok2 = $chunk['content']
    if ($null -ne $contentTok2) {
        $s2 = Get-JStr $contentTok2
        if ($null -ne $s2) { $raw = $s2.Trim() }
    }
    if (($raw.Length -gt 0) -and (-not $raw.StartsWith('[FIG:')) -and ($raw.Length -ge 8)) { return Strip-LatexResidue (Strip-HtmlTags $raw) }

    if (($null -ne $text) -and ($text.Length -gt 0)) { return Strip-LatexResidue (Strip-HtmlTags $text) }

    $note = ''
    if ($null -ne $faces) {
        $figFace = $faces['fig']
        if ($null -ne $figFace) {
            $noteTok = $figFace['note']
            if ($null -ne $noteTok) {
                $s3 = Get-JStr $noteTok
                if ($null -ne $s3) { $note = $s3 }
            }
        }
    }
    $note = $note.Trim()
    $note = [regex]::Replace($note, $PAT1, '')
    $note = [regex]::Replace($note, $PAT2, '')
    $note = [regex]::Replace($note, $PAT3, '')
    return Strip-LatexResidue (Strip-HtmlTags $note.Trim())
}

function Test-RetrievableAtom($chunk) {
    $t = Get-AtomSearchText $chunk
    if ($t.Length -lt 4) { return $false }
    $faces = $chunk['faces']
    $hasTextFace = ($null -ne $faces) -and ($null -ne $faces['text'])
    $kindTok = $chunk['kind']
    $kind = if ($null -ne $kindTok) { Get-JStr $kindTok } else { '' }
    if (($kind -eq 'fig') -and ($t.Length -lt 24) -and (-not $hasTextFace)) { return $false }
    if (($kind -eq 'fig') -and (-not $hasTextFace)) {
        $rawNote = ''
        if ($null -ne $faces) {
            $figFace = $faces['fig']
            if ($null -ne $figFace) {
                $noteTok = $figFace['note']
                if ($null -ne $noteTok) {
                    $s4 = Get-JStr $noteTok
                    if ($null -ne $s4) { $rawNote = $s4 }
                }
            }
        }
        if ($rawNote.Contains($NO_TEXT_LAYER) -or $rawNote.Contains($NOT_OCR)) { return $false }
    }
    return $true
}

function Build-PureTextTable($chunksArray) {
    $sb = New-Object System.Text.StringBuilder
    $first = $true
    foreach ($chunk in $chunksArray) {
        if (-not (Test-RetrievableAtom $chunk)) { continue }
        $text = (Get-AtomSearchText $chunk).Trim()
        if (-not $text) { continue }
        if (-not $first) { [void]$sb.Append("`n") }
        [void]$sb.Append($text)
        $first = $false
    }
    return $sb.ToString()
}

Write-Output "========== Adjacency pair scale and merge-necessity analysis =========="

Write-Output "Loading final-noun-index.json via Newtonsoft.Json ..."
$finalJsonText = [System.IO.File]::ReadAllText($FinalIndexPath)
$finalObj = [Newtonsoft.Json.Linq.JObject]::Parse($finalJsonText)
$nounsToken = $finalObj['nouns']
$totalOffsetsMeta = $finalObj['meta']['totalOffsets'].ToString()
Write-Output ("Final noun table (s0+s1): {0} nouns, {1} total offsets" -f $nounsToken.Count, $totalOffsetsMeta)

Write-Output "Loading docuverse.json via Newtonsoft.Json ..."
$docJsonText = [System.IO.File]::ReadAllText($DocuversePath)
$docObj = [Newtonsoft.Json.Linq.JObject]::Parse($docJsonText)
$chunksToken = $docObj['bookIndex']['chunks']
Write-Output ("Chunks: {0}" -f $chunksToken.Count)

Write-Output "Building pure text table (for connector chars) ..."
$fullText = Build-PureTextTable $chunksToken
Write-Output ("Pure text table: {0} chars" -f $fullText.Length)

# Build noun list as plain PS objects (id, surface, offsets[])
$nouns = New-Object System.Collections.Generic.List[object]
foreach ($nounTok in $nounsToken) {
    $id = [string]$nounTok['id']
    $surface = [string]$nounTok['surface']
    $offsets = New-Object System.Collections.Generic.List[object]
    foreach ($offTok in $nounTok['offsets']) {
        $offsets.Add([pscustomobject]@{ start = [int]$offTok['start']; end = [int]$offTok['end'] })
    }
    $nouns.Add([pscustomobject]@{ id = $id; surface = $surface; offsets = $offsets })
}
Write-Output ("Parsed {0} noun entries into memory" -f $nouns.Count)

$startIndex = New-Object 'System.Collections.Generic.Dictionary[int, System.Collections.Generic.List[object]]'
foreach ($entry in $nouns) {
    foreach ($off in $entry.offsets) {
        $s = [int]$off.start
        if (-not $startIndex.ContainsKey($s)) {
            $startIndex[$s] = New-Object 'System.Collections.Generic.List[object]'
        }
        $startIndex[$s].Add([pscustomobject]@{ entry = $entry; off = $off })
    }
}

$pairsByGap = @{ 0 = New-Object System.Collections.Generic.List[object]; 1 = New-Object System.Collections.Generic.List[object]; 2 = New-Object System.Collections.Generic.List[object]; 3 = New-Object System.Collections.Generic.List[object] }
$seenPairKeys = New-Object 'System.Collections.Generic.HashSet[string]'

foreach ($leftEntry in $nouns) {
    $leftId = $leftEntry.id
    foreach ($leftOff in $leftEntry.offsets) {
        $leftEnd = [int]$leftOff.end
        for ($gap = 0; $gap -le $AdjacencyTolerance; $gap++) {
            $rightStart = $leftEnd + $gap
            $rightCandidates = $null
            if ($startIndex.TryGetValue($rightStart, [ref]$rightCandidates)) {
                foreach ($cand in $rightCandidates) {
                    $rightEntry = $cand.entry
                    $rightOff = $cand.off
                    if ($rightEntry.id -eq $leftId) { continue }
                    $key = "$leftId@$($leftOff.start)|$($rightEntry.id)@$($rightOff.start)"
                    if ($seenPairKeys.Contains($key)) { continue }
                    [void]$seenPairKeys.Add($key)

                    $connector = $fullText.Substring($leftEnd, [int]$rightOff.start - $leftEnd)
                    $pairsByGap[$gap].Add([pscustomobject]@{
                        leftId = $leftId
                        rightId = $rightEntry.id
                        leftSurface = $leftEntry.surface
                        rightSurface = $rightEntry.surface
                        leftEnd = $leftEnd
                        rightStart = [int]$rightOff.start
                        connector = $connector
                    })
                }
            }
        }
    }
}

$total = ($pairsByGap[0].Count + $pairsByGap[1].Count + $pairsByGap[2].Count + $pairsByGap[3].Count)
Write-Output "========== Counts by gap =========="
foreach ($gap in 0..3) { Write-Output ("gap={0}: {1} pairs" -f $gap, $pairsByGap[$gap].Count) }
Write-Output ("Total (gap 0-{0}): {1} pairs" -f $AdjacencyTolerance, $total)

$gap0 = $pairsByGap[0]
Write-Output ("gap=0 (strictly zero gap, no chars between): {0} pairs" -f $gap0.Count)

$gap1 = $pairsByGap[1]
$gap1Space = @($gap1 | Where-Object { $_.connector -eq ' ' })
$gap1SentenceBreak = @($gap1 | Where-Object { $_.connector -match '[.!?\n]' })
$gap1Other = @($gap1 | Where-Object { $_.connector -ne ' ' -and ($_.connector -notmatch '[.!?\n]') })
Write-Output ("gap=1 breakdown (total {0}):" -f $gap1.Count)
Write-Output ("  connector = single space (most likely compound-noun candidate): {0} pairs" -f $gap1Space.Count)
Write-Output ("  connector has sentence-end punctuation/newline (should exclude): {0} pairs" -f $gap1SentenceBreak.Count)
Write-Output ("  connector = other symbol: {0} pairs" -f $gap1Other.Count)

$excludeChars = @('.', '!', '?', "`n", ',', ';', ':', '(', ')', '"')
$combinedList = New-Object System.Collections.Generic.List[object]
foreach ($item in $gap0) { $combinedList.Add($item) }
foreach ($item in $gap1) { $combinedList.Add($item) }
$strictCandidates = @($combinedList | Where-Object {
    $c = $_.connector
    $hasExcluded = $false
    foreach ($ch in $excludeChars) { if ($c.Contains($ch)) { $hasExcluded = $true; break } }
    -not $hasExcluded
})
Write-Output ("Strict-rule candidates (gap<=1, excluding punctuation): {0} pairs" -f $strictCandidates.Count)

Write-Output "First 30 strict candidate samples (for manual spot check):"
$i = 0
foreach ($p in $strictCandidates) {
    if ($i -ge 30) { break }
    $conn = if ($p.connector -eq '') { '[EMPTY]' } else { "[$($p.connector)]" }
    Write-Output ("  {0}. [{1}]{2}[{3}]" -f ($i + 1), $p.leftSurface, $conn, $p.rightSurface)
    $i++
}

Write-Output "========== Cost estimate (vs merge-review LLM) =========="
$batchSize = 10
Write-Output "If running LLM merge review with current ADJACENCY_TOLERANCE=3 (gap 0-3, full):"
Write-Output ("  Candidates: {0} pairs -> batched (10/batch) -> {1} requests" -f $total, [math]::Ceiling($total / $batchSize))
Write-Output "If only running LLM on strict-rule candidates (gap<=1, punctuation excluded):"
$strictCount = $strictCandidates.Count
Write-Output ("  Candidates: {0} pairs -> batched (10/batch) -> {1} requests" -f $strictCount, [math]::Ceiling($strictCount / $batchSize))

$output = [pscustomobject]@{
    meta = [pscustomobject]@{
        totalNouns = $nouns.Count
        adjacencyTolerance = $AdjacencyTolerance
        totalPairsGap0to3 = $total
        pairsByGap = [pscustomobject]@{ '0' = $pairsByGap[0].Count; '1' = $pairsByGap[1].Count; '2' = $pairsByGap[2].Count; '3' = $pairsByGap[3].Count }
        strictCandidateCount = $strictCount
    }
    strictCandidates = $strictCandidates
}
$output | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutPath -Encoding utf8
Write-Output ("Detailed candidates written to: {0}" -f $OutPath)
