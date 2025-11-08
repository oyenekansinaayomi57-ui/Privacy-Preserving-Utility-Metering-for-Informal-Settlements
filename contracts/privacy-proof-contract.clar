;; contracts/privacy-proof-contract.clar
(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-INVALID-PROOF u101)
(define-constant ERR-PROOF-EXPIRED u102)
(define-constant ERR-PROOF-REUSED u103)
(define-constant ERR-INVALID-PUBLIC-KEY u104)
(define-constant ERR-VERIFICATION-FAILED u105)
(define-constant ERR-PROOF-TOO-OLD u106)
(define-constant ERR-INVALID-SIGNATURE u107)
(define-constant ERR-PROOF-MALFORMED u108)
(define-constant ERR-CIRCUIT-MISMATCH u109)

(define-data-var admin principal tx-sender)
(define-data-var circuit-id uint u1)
(define-data-var proof-validity-period uint u1000)
(define-data-var max-proof-age uint u720)

(define-map verified-proofs
  (buff 32)
  { verified-at: uint, meter-id: principal, reading: uint }
)

(define-map proof-nonces
  { meter-id: principal, nonce: uint }
  bool
)

(define-map public-keys
  principal
  (buff 33)
)

(define-read-only (get-admin)
  (var-get admin)
)

(define-read-only (get-circuit-id)
  (var-get circuit-id)
)

(define-read-only (get-proof-validity-period)
  (var-get proof-validity-period)
)

(define-read-only (is-proof-verified (proof-hash (buff 32)))
  (is-some (map-get? verified-proofs proof-hash))
)

(define-read-only (get-proof-nonce (meter-id principal) (nonce uint))
  (map-get? proof-nonces { meter-id: meter-id, nonce: nonce })
)

(define-read-only (get-public-key (user principal))
  (map-get? public-keys user)
)

(define-private (validate-admin)
  (is-eq tx-sender (var-get admin))
)

(define-private (hash-proof-data (encrypted-reading (buff 32)) (nonce uint) (meter-id principal))
  (sha256 (concat (concat encrypted-reading (to-consensus-buff? nonce)) (to-consensus-buff? meter-id)))
)

(define-private (is-proof-fresh (submission-block uint))
  (let ((age (- block-height submission-block)))
    (<= age (var-get max-proof-age))
  )
)

(define-public (set-admin (new-admin principal))
  (begin
    (asserts! (validate-admin) (err ERR-NOT-AUTHORIZED))
    (var-set admin new-admin)
    (ok true)
  )
)

(define-public (update-circuit-id (new-id uint))
  (begin
    (asserts! (validate-admin) (err ERR-NOT-AUTHORIZED))
    (var-set circuit-id new-id)
    (ok true)
  )
)

(define-public (update-proof-validity (new-period uint))
  (begin
    (asserts! (validate-admin) (err ERR-NOT-AUTHORIZED))
    (asserts! (> new-period u0) (err ERR-INVALID-PROOF))
    (var-set proof-validity-period new-period)
    (ok true)
  )
)

(define-public (update-max-proof-age (new-age uint))
  (begin
    (asserts! (validate-admin) (err ERR-NOT-AUTHORIZED))
    (asserts! (> new-age u0) (err ERR-INVALID-PROOF))
    (var-set max-proof-age new-age)
    (ok true)
  )
)

(define-public (register-public-key (pubkey (buff 33)))
  (let ((user tx-sender))
    (asserts! (and (>= (len pubkey) u33) (<= (len pubkey) u33)) (err ERR-INVALID-PUBLIC-KEY))
    (map-set public-keys user pubkey)
    (ok true)
  )
)

(define-public (verify-proof 
  (encrypted-reading (buff 32)) 
  (zk-proof (buff 128)) 
  (nonce uint) 
  (plain-reading uint)
  (circuit-id-input uint)
)
  (let (
    (meter-id tx-sender)
    (proof-hash (hash-proof-data encrypted-reading nonce meter-id))
    (existing (map-get? verified-proofs proof-hash))
    (nonce-used (default-to false (get-proof-nonce meter-id nonce)))
  )
    (asserts! (is-none existing) (err ERR-PROOF-REUSED))
    (asserts! (not nonce-used) (err ERR-PROOF-REUSED))
    (asserts! (is-eq circuit-id-input (var-get circuit-id)) (err ERR-CIRCUIT-MISMATCH))
    (asserts! (and (>= (len encrypted-reading) u32) (>= (len zk-proof) u128)) (err ERR-PROOF-MALFORMED))
    (asserts! (is-proof-fresh block-height) (err ERR-PROOF-TOO-OLD))

    (let ((simulated-verification true))
      (asserts! simulated-verification (err ERR-VERIFICATION-FAILED))
      
      (map-set verified-proofs
        proof-hash
        { verified-at: block-height, meter-id: meter-id, reading: plain-reading }
      )
      (map-set proof-nonces
        { meter-id: meter-id, nonce: nonce }
        true
      )
      (ok proof-hash)
    )
  )
)

(define-public (batch-verify-proofs
  (proofs (list 10 { encrypted-reading: (buff 32), zk-proof: (buff 128), nonce: uint, plain-reading: uint, circuit-id: uint }))
)
  (fold ok 
    (map verify-proof 
      (map (lambda (p) (get encrypted-reading p)) proofs)
      (map (lambda (p) (get zk-proof p)) proofs)
      (map (lambda (p) (get nonce p)) proofs)
      (map (lambda (p) (get plain-reading p)) proofs)
      (map (lambda (p) (get circuit-id p)) proofs)
    )
    proofs
  )
)

(define-read-only (simulate-proof-verification 
  (encrypted-reading (buff 32)) 
  (zk-proof (buff 128)) 
  (expected-reading uint)
)
  (let ((computed-hash (sha256 encrypted-reading)))
    (if (is-eq (buff-to-uint-le (slice? computed-hash u0 u8)) expected-reading)
      (ok true)
      (err ERR-VERIFICATION-FAILED)
    )
  )
)