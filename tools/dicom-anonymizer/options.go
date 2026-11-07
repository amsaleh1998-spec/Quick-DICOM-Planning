package main

import "dicomanon/anon"

// version is set at build time (-ldflags "-X main.version=…").
var version = "dev"

const appName = "DICOM Anonymizer"

func defaultOptions() anon.Options {
	return anon.Options{PatientName: "ANONYMOUS", PatientID: "ANON"}
}
