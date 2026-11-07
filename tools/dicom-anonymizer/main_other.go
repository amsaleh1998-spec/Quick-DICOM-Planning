//go:build !windows

// Command-line version for macOS / Linux (the Windows build is the window app in gui_windows.go).
package main

import (
	"crypto/rand"
	"flag"
	"fmt"
	"os"

	"dicomanon/anon"
)

func main() {
	o := defaultOptions()
	out := flag.String("out", "", "output folder (required)")
	flag.StringVar(&o.PatientName, "name", o.PatientName, "new patient name")
	flag.StringVar(&o.PatientID, "id", o.PatientID, "new patient ID")
	flag.BoolVar(&o.KeepDates, "keep-dates", false, "keep dates and times")
	flag.BoolVar(&o.KeepPatientChars, "keep-patient", false, "keep sex, age, size, weight")
	flag.BoolVar(&o.KeepDescriptions, "keep-descriptions", false, "keep study/series descriptions")
	flag.BoolVar(&o.KeepInstitution, "keep-institution", false, "keep institution name/address")
	flag.BoolVar(&o.KeepDevice, "keep-device", false, "keep station name, serial numbers")
	flag.BoolVar(&o.KeepUIDs, "keep-uids", false, "keep the original UIDs")
	flag.BoolVar(&o.KeepPrivate, "keep-private", false, "keep private (vendor) tags")
	keepNames := flag.Bool("keep-names", false, "keep the original file and folder names")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "%s %s\nusage: %s -out <folder> [options] <files or folders>…\n", appName, version, os.Args[0])
		flag.PrintDefaults()
	}
	flag.Parse()
	if *out == "" || flag.NArg() == 0 {
		flag.Usage()
		os.Exit(2)
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		panic(err)
	}
	job := &anon.Job{Inputs: flag.Args(), OutDir: *out, Rename: !*keepNames, Session: anon.NewSession(o, secret)}
	job.OnEvent = func(e anon.Event) {
		if e.Text == "" {
			return
		}
		prefix := ""
		switch e.Level {
		case anon.Warn:
			prefix = "warning: "
		case anon.Error:
			prefix = "error: "
		}
		fmt.Fprintln(os.Stderr, prefix+e.Text)
	}
	res, err := job.Run()
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	if res.Failed > 0 {
		os.Exit(1)
	}
}
