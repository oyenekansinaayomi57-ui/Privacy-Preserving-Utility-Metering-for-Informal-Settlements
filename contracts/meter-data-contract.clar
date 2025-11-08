;; contracts/meter-data-contract.clar
(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-INVALID-PROOF u101)
(define-constant ERR-ALREADY-SUBMITTED u102)
(define-constant ERR-METER-NOT-REGISTERED u103)
(define-constant ERR-PERIOD-CLOSED u104)
(define-constant ERR-INVALID-READING u105)
(define-constant ERR-PROOF-VERIFICATION-FAILED u106)
(define-constant ERR-READING-TOO-HIGH u107)
(define-constant ERR-READING-TOO-LOW u108)
(define-constant ERR-BLOCK-HEIGHT-MISMATCH u109)

(define-data-var current-period uint u0)
(define-data-var period-duration uint u144)
(define-data-var max-reading-delta uint u1000000)
(define-data-var proof-verifier principal 'SP000000000000000000002Q6VF78.privacy-proof-contract)

(define-map meter-registrations
  { meter-id: principal }
  { settlement-id: uint, last-reading: uint, registered-at: uint, active: bool }
)

(define-map usage-submissions
  { meter-id: principal, period: uint }
  { encrypted-reading: (buff 32), zk-proof: (buff 128), submitted-at: uint, verified: bool, reading-value: uint }
)

(define-map period-metadata
  uint
  { start-block: uint, end-block: uint, total-submissions: uint, verified-count: uint, status: (string-ascii 20) }
)

(define-read-only (get-current-period)
  (var-get current-period)
)

(define-read-only (get-meter-info (meter-id principal))
  (map-get? meter-registrations { meter-id: meter-id })
)

(define-read-only (get-submission (meter-id principal) (period uint))
  (map-get? usage-submissions { meter-id: meter-id, period: period })
)

(define-read-only (get-period-info (period uint))
  (map-get? period-metadata period)
)

(define-private (is-period-active (period uint))
  (let ((info (map-get? period-metadata period)))
    (match info
      data (is-eq (get status data) "active")
      false
    )
  )
)

(define-private (validate-meter-registered (meter-id principal))
  (match (map-get? meter-registrations { meter-id: meter-id })
    info (if (get active info) (ok true) (err ERR-METER-NOT-REGISTERED))
    (err ERR-METER-NOT-REGISTERED)
  )
)

(define-private (validate-reading-range (new-reading uint) (last-reading uint))
  (let ((delta (- new-reading last-reading)))
    (if (and (>= new-reading last-reading) (<= delta (var-get max-reading-delta)))
      (ok true)
      (err ERR-READING-TOO-HIGH)
    )
  )
)

(define-private (verify-zk-proof (encrypted-reading (buff 32)) (zk-proof (buff 128)))
  (contract-call? (var-get proof-verifier) verify-proof encrypted-reading zk-proof)
)

(define-public (register-meter (settlement-id uint))
  (let (
    (meter-id tx-sender)
    (existing (map-get? meter-registrations { meter-id: meter-id }))
  )
    (asserts! (is-none existing) (err ERR-METER-NOT-REGISTERED))
    (map-set meter-registrations
      { meter-id: meter-id }
      { settlement-id: settlement-id, last-reading: u0, registered-at: block-height, active: true }
    )
    (print { event: "meter-registered", meter-id: meter-id, settlement-id: settlement-id })
    (ok true)
  )
)

(define-public (deregister-meter)
  (let ((meter-id tx-sender))
    (try! (validate-meter-registered meter-id))
    (map-set meter-registrations
      { meter-id: meter-id }
      (merge (unwrap! (map-get? meter-registrations { meter-id: meter-id }) (err ERR-METER-NOT-REGISTERED)) { active: false })
    )
    (ok true)
  )
)

(define-public (submit-usage-proof (encrypted-reading (buff 32)) (zk-proof (buff 128)) (plain-reading uint))
  (let (
    (meter-id tx-sender)
    (period (var-get current-period))
    (meter-info (unwrap! (map-get? meter-registrations { meter-id: meter-id }) (err ERR-METER-NOT-REGISTERED)))
    (existing (map-get? usage-submissions { meter-id: meter-id, period: period }))
  )
    (asserts! (get active meter-info) (err ERR-METER-NOT-REGISTERED))
    (asserts! (is-period-active period) (err ERR-PERIOD-CLOSED))
    (asserts! (is-none existing) (err ERR-ALREADY-SUBMITTED))
    (try! (validate-reading-range plain-reading (get last-reading meter-info)))
    (asserts! (verify-zk-proof encrypted-reading zk-proof) (err ERR-PROOF-VERIFICATION-FAILED))
    
    (map-set usage-submissions
      { meter-id: meter-id, period: period }
      { encrypted-reading: encrypted-reading, zk-proof: zk-proof, submitted-at: block-height, verified: true, reading-value: plain-reading }
    )
    
    (map-set meter-registrations
      { meter-id: meter-id }
      (merge meter-info { last-reading: plain-reading })
    )
    
    (match (map-get? period-metadata period)
      meta (map-set period-metadata period
             (merge meta { total-submissions: (+ (get total-submissions meta) u1), verified-count: (+ (get verified-count meta) u1) }))
      (map-set period-metadata period
        { start-block: block-height, end-block: (+ block-height (var-get period-duration)), total-submissions: u1, verified-count: u1, status: "active" })
    )
    
    (print { event: "usage-submitted", meter-id: meter-id, period: period, reading: plain-reading })
    (ok true)
  )
)

(define-public (advance-period)
  (let ((period (var-get current-period)))
    (asserts! (is-eq tx-sender (var-get proof-verifier)) (err ERR-NOT-AUTHORIZED))
    (match (map-get? period-metadata period)
      meta (map-set period-metadata period (merge meta { status: "closed" }))
      (ok true)
    )
    (var-set current-period (+ period u1))
    (map-set period-metadata (+ period u1)
      { start-block: block-height, end-block: (+ block-height (var-get period-duration)), total-submissions: u0, verified-count: u0, status: "active" })
    (ok (+ period u1))
  )
)

(define-public (update-max-delta (new-delta uint))
  (begin
    (asserts! (is-eq tx-sender (var-get proof-verifier)) (err ERR-NOT-AUTHORIZED))
    (var-set max-reading-delta new-delta)
    (ok true)
  )
)

(define-public (update-period-duration (new-duration uint))
  (begin
    (asserts! (is-eq tx-sender (var-get proof-verifier)) (err ERR-NOT-AUTHORIZED))
    (asserts! (> new-duration u0) (err ERR-INVALID-READING))
    (var-set period-duration new-duration)
    (ok true)
  )
)

(define-public (emergency-pause)
  (begin
    (asserts! (is-eq tx-sender (var-get proof-verifier)) (err ERR-NOT-AUTHORIZED))
    (let ((period (var-get current-period)))
      (match (map-get? period-metadata period)
        meta (map-set period-metadata period (merge meta { status: "paused" }))
        (ok true)
      )
    )
    (ok true)
  )
)

(define-read-only (get-all-submissions-in-period (period uint))
  (let ((period-info (map-get? period-metadata period)))
    (match period-info
      info (ok {
        period: period,
        start: (get start-block info),
        end: (get end-block info),
        submissions: (get total-submissions info),
        verified: (get verified-count info),
        status: (get status info)
      })
      (err u404)
    )
  )
)